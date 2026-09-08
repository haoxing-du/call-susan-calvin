import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { startLocalApp } from "../server/launcher.mjs";
import { launchReview } from "../server/integration.mjs";
import { prepareFeedback } from "../server/classifier-feedback.mjs";
import { sanitizeDonation } from "../server/donation-schema.mjs";
import { encryptDonation, decryptDonation } from "../server/donation-crypto.mjs";
import { Reviews } from "../server/reviews.mjs";

const context = { originalLabel: "yelling", candidateId: "interaction-1", judgedText: "Email person@example.com about Acme", occurrences: 1, confidence: 1, judge: { model: "openai/gpt-5.6-luna", promptVersion: 1 } };
const stop = async (local) => { if (local.server.listening) await new Promise(resolve => local.server.close(resolve)); };

test("feedback redactions and consent survive batching, normalization and encryption", async () => {
  const prepared = await prepareFeedback(context, { correctedLabel: "neither", note: "Ask Acme at person@example.com" }, { mode: "custom" }, [{ type: "text", pattern: "Acme" }]);
  assert.doesNotMatch(JSON.stringify(prepared.value), /person@example.com|Acme/);
  const reviews = new Reviews({});
  reviews.read = async () => ({ sessions: [{ source: "codex", messages: [{ role: "user", text: "Reviewed transcript" }] }], detectionCount: 0 });
  const job = { id: crypto.randomUUID(), options: { mode: "custom" }, batches: [[0]], feedbackSnapshot: prepared };
  const input = await reviews.donation(job, [0], { researchDonation: true, classifierFeedback: true, consentedAt: "2026-09-08T12:00:00.000Z" }, "0.6.0", 0);
  const normalized = sanitizeDonation(input);
  assert.deepEqual(normalized.classifierFeedback, prepared.value);
  assert.equal(normalized.consent.consentVersion, 2);
  assert.match(normalized.consent.statement, /evaluate and improve Behavior Wrapped/);
  assert.equal(sanitizeDonation({ ...input, consent: { researchDonation: true } }), null);
  assert.equal(sanitizeDonation({ ...input, sessions: [...input.sessions, ...input.sessions] }), null);
  assert.equal(sanitizeDonation({ ...input, group: { ...input.group, count: 2 } }), null);
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const encrypted = encryptDonation(input, keys.publicKey);
  assert.equal(encrypted.metadata.consentVersion, 2);
  assert.doesNotMatch(JSON.stringify(encrypted), /judgedText|correctedLabel|Reviewed transcript/);
  assert.deepEqual(decryptDonation(encrypted, keys.privateKey), normalized);
});

test("local correction review rejects changed selections, forged provenance and stale consent", async () => {
  const initial = await startLocalApp({ port: 0, demo: true });
  const catalog = await (await fetch(`${initial.url}/api/catalog`)).json();
  await stop(initial);
  const id = catalog.sessions[0].id;
  const local = await startLocalApp({ port: 0, demo: true, feedback: { ...context, sessionId: id } });
  const call = (route, body) => fetch(`${local.url}${route}`, { method: body === undefined ? "GET" : "POST", headers: { origin: local.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const selected = await (await call("/api/catalog")).json();
    assert.deepEqual(selected.sessions.map(s => s.id), [id]);
    assert.equal((await call("/api/reviews", { sessionIds: catalog.sessions.map(s => s.id), mode: "custom" })).status, 400);
    let job = await (await call("/api/reviews", { sessionIds: [id], mode: "custom" })).json();
    while (job.status === "preparing") job = await (await call(`/api/reviews/${job.id}`)).json();
    assert.equal(job.status, "ready");
    const route = `/api/reviews/${job.id}`;
    assert.equal((await call(`${route}/donate`, { researchDonation: true })).status, 400);
    const prepare = async () => (await call(`${route}/feedback`, { originalLabel: "thanking", correctedLabel: "neither", judgedText: "Invented", note: "My explanation" })).json();
    let snapshot = await prepare();
    assert.equal(snapshot.value.originalLabel, "yelling");
    assert.equal(snapshot.value.judgedText, "Email [REDACTED EMAIL] about Acme");
    assert.equal((await call(`${route}/donate`, { researchDonation: true, classifierFeedback: true, feedbackRevision: "wrong" })).status, 400);
    let update = await (await call(`${route}/custom`, { type: "text", pattern: "Acme" })).json();
    while (update.redacting) update = await (await call(route)).json();
    assert.equal((await call(`${route}/donate`, { researchDonation: true, classifierFeedback: true, feedbackRevision: snapshot.revision })).status, 400);
    snapshot = await prepare();
    assert.doesNotMatch(snapshot.value.judgedText, /Acme/);
    assert.equal((await call(`${route}/donate`, { researchDonation: true, classifierFeedback: true, feedbackRevision: snapshot.revision })).status, 202);
    do { job = await (await call(route)).json(); } while (job.status === "uploading");
    assert.equal(job.status, "complete");
    assert.equal(job.donationId, "demo-not-transmitted");
  } finally { await stop(local); }
  await assert.rejects(startLocalApp({ port: 0, demo: true, feedback: { ...context, sessionId: "f".repeat(16) } }), /no longer available/);
});

test("the package launcher starts an independent synthetic app that can stop before donation", async () => {
  const local = await launchReview({ demo: true });
  const catalog = await (await fetch(`${local.url}/api/catalog`)).json();
  assert.equal(catalog.integration, true);
  assert.equal(catalog.demo, true);
  assert.equal(catalog.feedback, undefined);
  assert.equal(catalog.sessions.length, 3);
  assert.equal((await fetch(`${local.url}/api/shutdown`, { method: "POST", headers: { origin: local.url } })).status, 200);
});
