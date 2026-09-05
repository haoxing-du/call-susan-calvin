// Synthetic data only. Runs the real discovery, redaction, review, encryption,
// upload, Worker, local D1/R2, decryption and deletion paths, without Internet uploads.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { saveDonationReceipt, deleteDonationReceipt } from "../server/store.mjs";
import { discoverAllSessions } from "../server/discovery.mjs";
import { Reviews } from "../server/reviews.mjs";
import { submitDonation, deleteDonation } from "../server/donation-client.mjs";
import { decryptDonation, parseStoredDonation } from "../server/donation-crypto.mjs";
import { sanitizeDonation } from "../server/donation-schema.mjs";
import { createReceiver } from "../tests/helpers/receiver.mjs";

const sessionCount = Number(process.env.STRESS_SESSIONS || 14100);
const messageCount = Number(process.env.STRESS_MESSAGES || 573700);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "susan-calvin-stress-"));
const input = path.join(root, "codex");
await fs.mkdir(input);
let reviews, receiver, productionReceipt;
const production = process.env.STRESS_PRODUCTION === "1";
const started = Date.now();
let inputBytes = 0, transcriptBytes = 0, peakRss = 0, maxRequest = 0, requestCount = 0;
const track = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
try {
  for (let i = 0; i < sessionCount; i++) {
    const count = Math.floor(messageCount / sessionCount) + (i < messageCount % sessionCount ? 1 : 0);
    const records = [];
    for (let j = 0; j < count; j++) {
      // Spaced random text avoids a misleading compression test based on repeated strings.
      const words = crypto.randomBytes(420).toString("base64url").match(/.{1,8}/g).join(" ");
      const text = `Synthetic session ${i}, turn ${j}. ${words}`;
      transcriptBytes += Buffer.byteLength(text);
      records.push(JSON.stringify({ type: "response_item", timestamp: new Date(Date.UTC(2026, 8, 1) + j * 1000).toISOString(), payload: { type: "message", role: j % 2 ? "assistant" : "user", content: [{ type: j % 2 ? "output_text" : "input_text", text }] } }));
    }
    const raw = records.join("\n") + "\n";
    inputBytes += Buffer.byteLength(raw);
    await fs.writeFile(path.join(input, `${i}.jsonl`), raw);
    if (i && i % 3000 === 0) console.log(`Generated ${i}/${sessionCount} synthetic sessions`);
  }
  const catalog = await discoverAllSessions({ codexRoots: [input], claudeRoot: path.join(root, "absent"), coworkRoot: path.join(root, "absent"), cache: false });
  assert.equal(catalog.sessions.length, sessionCount);
  console.log(`Discovered ${sessionCount} sessions; preparing review`);
  reviews = new Reviews(catalog, { root });
  const status = await reviews.create(catalog.sessions.map((s) => s.id), { mode: "standard" });
  const job = reviews.get(status.id);
  await job.task;
  assert.equal(job.status, "ready", job.error);
  assert.equal(job.messages, messageCount);
  console.log(`Prepared ${job.messages} messages in ${job.batches.length} bounded batches`);
  receiver = await createReceiver();
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const token = crypto.randomBytes(32).toString("base64url");
  if (production) productionReceipt = saveDonationReceipt({ donationId: job.id, deletionToken: token, donationRunId: job.id, group: true, sourceTypes: ["codex"], sessionCount });
  const consent = { researchDonation: true, consentedAt: "2026-09-01T00:00:00Z" };
  const checksum = crypto.createHash("sha256");
  const options = {
    endpoint: "https://synthetic.test/v1/donations", publicKey: keys.publicKey, sleep: async () => {},
    fetchImpl: async (url, init) => {
      maxRequest = Math.max(maxRequest, Buffer.byteLength(init.body || ""));
      requestCount++;
      if (requestCount === 4) return new Response("{}", { status: 429 });
      const response = await receiver.mf.dispatchFetch(url, init);
      if (requestCount === 1) { await response.text(); throw new Error("Synthetic lost acknowledgement after storage"); }
      return response;
    },
  };
  for (let i = 0; i < job.batches.length; i++) {
    const donation = await reviews.donation(job, job.batches[i], consent, "0.2.0", i);
    checksum.update(JSON.stringify(sanitizeDonation(donation).sessions));
    await submitDonation(donation, token, options);
    if (production) await submitDonation({ ...donation, collector: { version: "0.2.0-synthetic" } }, token, { fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (!response.ok) console.log(JSON.stringify({ productionBatch: i, status: response.status, contentType: response.headers.get("content-type"), mitigated: response.headers.get("cf-mitigated") }));
      return response;
    } });
    if (i && i % (production ? 10 : 20) === 0) console.log(`Accepted ${i}/${job.batches.length} encrypted batches`);
  }
  const { results } = await receiver.db.prepare("SELECT object_key FROM susan_calvin_donations ORDER BY batch_index").all();
  assert.equal(results.length, job.batches.length);
  const recovered = crypto.createHash("sha256");
  let recoveredSessions = 0, recoveredMessages = 0;
  for (const row of results) {
    const envelope = parseStoredDonation(await (await receiver.bucket.get(row.object_key)).arrayBuffer());
    const donation = decryptDonation(envelope, keys.privateKey);
    recovered.update(JSON.stringify(donation.sessions));
    recoveredSessions += donation.sessions.length;
    recoveredMessages += donation.redactionSummary.messages;
  }
  assert.equal(recovered.digest("hex"), checksum.digest("hex"), "Every reviewed message and its order must survive storage and decryption");
  assert.equal(recoveredSessions, sessionCount); assert.equal(recoveredMessages, messageCount);
  for (let n = 0; n < 100; n++) {
    const delivered = await receiver.db.prepare("SELECT COUNT(*) AS n FROM test_deliveries").first();
    if (delivered.n) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await receiver.db.prepare("SELECT COUNT(*) AS n FROM test_deliveries").first()).n, 1);
  if (production) {
    const query = (sql) => JSON.parse(execFileSync("npx", ["--yes", "wrangler@4.86.0", "d1", "execute", "susan-calvin-donation-metadata", "--remote", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].results[0];
    const totals = query(`SELECT COUNT(*) AS batches, SUM(session_count) AS sessions, SUM(message_count) AS messages, SUM(object_bytes) AS encryptedBytes FROM susan_calvin_donations WHERE group_id = '${job.id}'`);
    assert.equal(totals.batches, job.batches.length); assert.equal(totals.sessions, sessionCount); assert.equal(totals.messages, messageCount);
    let delivery;
    for (let i = 0; i < 6; i++) {
      delivery = query(`SELECT delivered_at FROM susan_calvin_notifications WHERE id = '${job.id}'`);
      if (delivery?.delivered_at) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.ok(delivery?.delivered_at, "Production notification must be acknowledged by Zulip");
    console.log(JSON.stringify({ production: { ...totals, zulipAcknowledged: true } }));
  }
  await deleteDonation(job.id, token, { ...options, group: true });
  assert.equal((await receiver.bucket.list()).objects.length, 0);
  assert.equal((await receiver.db.prepare("SELECT COUNT(*) AS n FROM susan_calvin_donations").first()).n, 0);
  console.log(JSON.stringify({ sessions: sessionCount, messages: messageCount, transcriptBytes, sourceBytes: inputBytes, batches: job.batches.length, maxRequestBytes: maxRequest, nodePeakRssBytes: peakRss, seconds: (Date.now() - started) / 1000, completeTextChecksum: "matched", notifications: 1, lostResponseRetry: "passed", rateLimitRetry: "passed", deletion: "passed" }, null, 2));
} finally {
  clearInterval(track);
  if (productionReceipt) {
    try {
      await deleteDonation(productionReceipt.donationId, productionReceipt.deletionToken, { group: true });
      deleteDonationReceipt(productionReceipt.donationId);
      console.log("Production synthetic donation deleted.");
    } catch (error) { console.error(`Synthetic cleanup needs retry using the saved receipt ${productionReceipt.donationId}: ${error.message}`); process.exitCode = 1; }
  }
  await reviews?.close();
  await receiver?.mf.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
