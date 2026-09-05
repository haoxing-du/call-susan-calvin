import fs from "node:fs";
import { Reviews, MAX_REVIEW_SESSIONS } from "./reviews.mjs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { discoverAllSessions, sessionsInWindow } from "./discovery.mjs";
import { makeDonationPreview } from "./donation-preview.mjs";
import { MAX_DONATION_BYTES, sanitizeDonation } from "./donation-schema.mjs";
import { submitDonation, deleteDonation } from "./donation-client.mjs";
import { createDeletionToken, deleteDonationReceipt, loadDonationReceipt, saveDonationReceipt } from "./store.mjs";

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require("../package.json");
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../app");
const fixtureRoot = path.resolve(here, "../fixtures");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function headers(type = "application/json; charset=utf-8") {
  return {
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function json(response, status, body) {
  response.writeHead(status, headers());
  response.end(JSON.stringify(body));
}

async function readBody(request, maximum = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function safeArray(value, pattern, maximum) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && pattern.test(item)).slice(0, maximum) : [];
}

function publicCatalog(sessions) {
  return sessions.map((session) => ({
    id: session.id,
    agent: session.agent,
    agentName: session.agentName,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    promptCount: session.promptCount,
    messageCount: session.messageCount,
    sizeBytes: session.sizeBytes,
    title: session.title,
    firstUserMessage: session.firstUserMessage,
  }));
}

export async function startLocalApp({ port = 4318, days = 30, sources = [], demo = false } = {}) {
  const discoveryOptions = demo ? {
    claudeRoot: path.join(fixtureRoot, "claude"),
    coworkRoot: path.join(fixtureRoot, "cowork"),
    codexRoots: [path.join(fixtureRoot, "codex")],
    cache: false,
  } : {};
  const catalog = await discoverAllSessions(discoveryOptions);
  const selected = demo ? catalog.sessions : sessionsInWindow(catalog.sessions, { days, sources });
  const selectedIds = new Set(selected.map((session) => session.id));
  const pendingDeletionTokens = new Map();
  const reviews = new Reviews(catalog);
  let completedDonation = false;
  let uploading = false;

  const server = http.createServer(async (request, response) => {
    const host = request.headers.host || `127.0.0.1:${port}`;
    const url = new URL(request.url, `http://${host}`);
    const expectedOrigins = new Set([`http://127.0.0.1:${server.address()?.port || port}`, `http://localhost:${server.address()?.port || port}`]);
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    try {
      if (mutating && !expectedOrigins.has(request.headers.origin || "")) return json(response, 403, { error: "This local action must come from the review app." });
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { app: "share-with-susan-calvin", version: APP_VERSION, local: true, demo });
      if (request.method === "GET" && url.pathname === "/api/catalog") return json(response, 200, {
        sessions: publicCatalog(selected),
        discoveredSessions: catalog.sessions.length,
        days,
        demo,
        privacy: "Nothing has left this machine.",
      });
      if (request.method === "POST" && url.pathname === "/api/shutdown") {
        if (!completedDonation || uploading) return json(response, 409, { error: "Finish the donation before closing the app." });
        response.once("finish", () => { server.close(); server.closeIdleConnections(); });
        return json(response, 200, { stopped: true });
      }
      if (request.method === "POST" && url.pathname === "/api/reviews") {
        const body = await readBody(request, MAX_REVIEW_SESSIONS * 20 + 200_000);
        if (!Array.isArray(body.sessionIds) || body.sessionIds.some((id) => !selectedIds.has(id))) return json(response, 400, { error: "Choose available sessions." });
        if (!["standard", "custom", "unredacted"].includes(body.mode)) return json(response, 400, { error: "Choose a donation mode." });
        const options = { mode: body.mode, unredacted: body.mode === "unredacted", disabledKinds: safeArray(body.disabledKinds, /^[a-z0-9-]{1,64}$/, 20), disabledMatches: safeArray(body.disabledMatches, /^[a-f0-9]{24}$/, 5_000) };
        return json(response, 202, await reviews.create(body.sessionIds, options));
      }
      const reviewMatch = url.pathname.match(/^\/api\/reviews\/([0-9a-f-]{36})(?:\/sessions\/(\d+)|\/(donate))?$/);
      if (reviewMatch) {
        const job = reviews.get(reviewMatch[1]);
        if (request.method === "GET" && reviewMatch[2] !== undefined) return json(response, 200, await reviews.read(job, Number(reviewMatch[2])));
        if (request.method === "PUT" && reviewMatch[2] !== undefined) {
          const body = await readBody(request, 8_000_000);
          await reviews.edit(job, Number(reviewMatch[2]), body.messages);
          return json(response, 200, { saved: true });
        }
        if (request.method === "GET" && !reviewMatch[3]) return json(response, 200, reviews.summary(job));
        if (request.method === "POST" && reviewMatch[3] === "donate") {
          const body = await readBody(request);
          if (!["ready", "paused"].includes(job.status) || uploading) return json(response, 409, { error: "The review is not ready for upload." });
          if (body.researchDonation !== true || (job.options.unredacted && body.unredactedData !== true)) return json(response, 400, { error: "Consent is required." });
          if (!job.consent) job.consent = { researchDonation: true, ...(job.options.unredacted ? { unredactedData: true } : {}), timestamps: body.timestamps === true, consentedAt: new Date().toISOString() };
          if (!job.token) job.token = createDeletionToken();
          // Save the group deletion credential BEFORE the first request, including uncertain responses.
          if (!demo) saveDonationReceipt({ donationId: job.id, deletionToken: job.token, donationRunId: job.id, group: true, sourceTypes: [...new Set(job.sessions.map((s) => s.source))], sessionCount: job.sessions.length });
          job.status = "uploading"; job.error = ""; uploading = true;
          job.task = (async () => {
            for (; job.uploaded < job.batches.length; job.uploaded++) {
              const donation = await reviews.donation(job, job.batches[job.uploaded], job.consent, APP_VERSION, job.uploaded);
              if (!demo) await submitDonation(donation, job.token);
            }
            await import("node:fs/promises").then(({ rm }) => rm(job.folder, { recursive: true, force: true })).catch(() => {});
            uploading = false; completedDonation = true; job.donationId = demo ? "demo-not-transmitted" : job.id; job.status = "complete";
          })().catch((error) => { job.status = "paused"; job.error = error.message; }).finally(() => { uploading = false; });
          return json(response, 202, reviews.summary(job));
        }
        return json(response, 405, { error: "Method not allowed." });
      }
      if (request.method === "POST" && url.pathname === "/api/donation-preview") {
        const body = await readBody(request);
        const sessionIds = safeArray(body.sessionIds, /^[a-f0-9]{16}$/, 250).filter((id) => selectedIds.has(id));
        if (!sessionIds.length) return json(response, 400, { error: "Choose at least one available session." });
        const disabledKinds = safeArray(body.disabledKinds, /^[a-z0-9-]{1,64}$/, 20);
        const disabledMatches = safeArray(body.disabledMatches, /^[a-f0-9]{24}$/, 5_000);
        const preview = await makeDonationPreview(catalog, sessionIds, { disabledKinds, disabledMatches, unredacted: body.mode === "unredacted" });
        return json(response, 200, preview);
      }
      if (request.method === "POST" && url.pathname === "/api/donations") {
        const body = await readBody(request, MAX_DONATION_BYTES + 1_000_000);
        const donation = sanitizeDonation({ ...body.donation, collector: { name: "share-with-susan-calvin", version: APP_VERSION } });
        if (!donation) return json(response, 400, { error: "The reviewed donation is invalid or too large." });
        if (demo) { completedDonation = true; return json(response, 201, { accepted: true, donationId: "demo-not-transmitted", demo: true }); }
        const deletionToken = pendingDeletionTokens.get(donation.donationRunId) || createDeletionToken();
        pendingDeletionTokens.set(donation.donationRunId, deletionToken);
        const result = await submitDonation(donation, deletionToken);
        const receipt = saveDonationReceipt({
          donationId: result.donation_id,
          deletionToken,
          donationRunId: donation.donationRunId,
          sourceTypes: donation.sourceTypes,
          sessionCount: donation.redactionSummary.sessions,
        });
        pendingDeletionTokens.delete(donation.donationRunId);
        completedDonation = true;
        return json(response, 201, { accepted: true, donationId: receipt.donationId, encrypted: true });
      }
      const donationMatch = url.pathname.match(/^\/api\/donations\/([0-9a-f-]{36})$/);
      if (request.method === "DELETE" && donationMatch) {
        const receipt = loadDonationReceipt(donationMatch[1]);
        if (!receipt) return json(response, 404, { error: "Local deletion receipt not found." });
        await deleteDonation(receipt.donationId, receipt.deletionToken, { group: receipt.group === true });
        deleteDonationReceipt(receipt.donationId);
        return json(response, 200, { deleted: true });
      }
      if (!new Set(["GET", "HEAD"]).has(request.method)) return json(response, 405, { error: "Method not allowed." });
      const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.resolve(appRoot, requested);
      if (!file.startsWith(`${appRoot}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(response, 404, { error: "Not found." });
      response.writeHead(200, headers(mime[path.extname(file)] || "application/octet-stream"));
      if (request.method === "HEAD") return response.end();
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, error.message === "Request too large" ? 413 : 500, { error: error.message || "Local processing failed." });
    }
  });

  server.once("close", () => { void reviews.close(); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actualPort = server.address().port;
  return { server, url: `http://127.0.0.1:${actualPort}`, sessionCount: selected.length, discoveredSessionCount: catalog.sessions.length };
}
