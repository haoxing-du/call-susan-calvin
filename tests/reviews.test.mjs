import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { Reviews, planBatches } from "../server/reviews.mjs";
import { encryptDonation, decryptDonation } from "../server/donation-crypto.mjs";
import { submitDonation } from "../server/donation-client.mjs";
import crypto from "node:crypto";

const message = { role: "user", text: "Keep the complete session" };
const catalog = { index: new Map(Array.from({ length: 501 }, (_, i) => [String(i), {}])) };
const preview = async (_catalog, [id]) => ({ detectionCount: 1, redactions: [], sessions: [{ sessionId: id, source: "codex", label: id, summary: "Synthetic", messages: [message, { role: "assistant", text: `Answer ${id}` }] }] });

test("disk snapshots support more than 250 sessions, preserve edits, and clean up", async () => {
  const reviews = new Reviews(catalog, { preview });
  const result = await reviews.create([...catalog.index.keys()], { mode: "standard" });
  const job = reviews.get(result.id);
  try {
    await job.task;
    assert.equal(job.status, "ready");
    assert.equal(job.sessions.length, 501);
    assert.deepEqual(job.batches.map((batch) => batch.length), [250, 250, 1]);
    assert.equal((await fs.stat(job.folder)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(`${job.folder}/0.json`)).mode & 0o777, 0o600);
    const before = await reviews.read(job, 0);
    await assert.rejects(reviews.edit(job, 0, [message]), /every message/);
    await assert.rejects(reviews.edit(job, 0, [{ ...message, text: " " }, before.sessions[0].messages[1]]), /blank/);
    const messages = [{ ...message, text: "[REDACTED]" }, before.sessions[0].messages[1]];
    await reviews.edit(job, 0, messages);
    assert.deepEqual((await reviews.read(job, 0)).sessions[0].messages, messages);
    const consent = { researchDonation: true, consentedAt: "2026-09-01T00:00:00Z" };
    const batch = await reviews.donation(job, job.batches[0], consent, "0.2.0", 0);
    assert.equal(batch.group.count, 3);
    assert.equal(batch.sessions[0].messages[0].text, "[REDACTED]");
    assert.equal(batch.donationRunId, (await reviews.donation(job, job.batches[0], consent, "0.2.0", 0)).donationRunId);
    assert.notEqual(batch.donationRunId, (await reviews.donation(job, job.batches[1], consent, "0.2.0", 1)).donationRunId);
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    const encrypted = encryptDonation(batch, keys.publicKey);
    assert.deepEqual(decryptDonation(encrypted, keys.privateKey).group, batch.group);
    encrypted.metadata.batchIndex++;
    assert.throws(() => decryptDonation(encrypted, keys.privateKey), /authenticate/);
  } finally { await reviews.close(); }
  await assert.rejects(fs.stat(job.folder), { code: "ENOENT" });
});

test("batch planning respects bytes, count and message boundaries without splitting a session", () => {
  const sessions = [{ bytes: 3_000_000, messageCount: 25_001 }, { bytes: 2_000_000, messageCount: 25_001 }, { bytes: 10, messageCount: 1 }];
  assert.deepEqual(planBatches(sessions), [[0], [1, 2]]);
  assert.throws(() => planBatches([{ bytes: 7_000_001, messageCount: 1 }]), /7 MB/);
  assert.throws(() => planBatches([{ bytes: 1, messageCount: 50_001 }]), /50,000/);
});

test("transient errors and lost responses retry the identical encrypted batch and token", async () => {
  const payload = { donationRunId: crypto.randomUUID(), redactionMode: "standard", sessions: [{ source: "codex", messages: [message] }], consent: { researchDonation: true } };
  const sent = [], delays = [];
  await submitDonation(payload, "t".repeat(43), { sleep: async (ms) => delays.push(ms), fetchImpl: async (_url, init) => {
    sent.push(init);
    if (sent.length === 1) throw new Error("Lost response");
    if (sent.length === 2) return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    return new Response(JSON.stringify({ accepted: true, donation_id: crypto.randomUUID() }), { status: 200 });
  } });
  assert.equal(sent.length, 3);
  assert.ok(sent.every((init) => init.body === sent[0].body && init.headers["x-susan-calvin-deletion-token"] === "t".repeat(43)));
  assert.deepEqual(delays, [1000, 60000]);
});
