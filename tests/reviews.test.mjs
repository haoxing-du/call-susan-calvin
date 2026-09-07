import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { Reviews, planBatches } from "../server/reviews.mjs";
import { encryptDonation, decryptDonation } from "../server/donation-crypto.mjs";
import { submitDonation } from "../server/donation-client.mjs";
import crypto from "node:crypto";

const message = { role: "user", text: "Keep the complete session", timestamp: "2026-09-01T12:00:00.000Z" };
const catalog = { index: new Map(Array.from({ length: 501 }, (_, i) => [String(i), {}])) };
const preview = async (_catalog, [id]) => ({ detectionCount: 1, redactions: [], sessions: [{ sessionId: id, source: "codex", label: id, summary: "Synthetic", messages: [message, { role: "assistant", text: `Answer ${id}` }] }] });

test("disk snapshots support more than 250 sessions, preserve transcripts, and clean up", async () => {
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
    await assert.rejects(reviews.redact(job, 0, { pattern: "complete", type: "text" }), /Customize redactions/);
    assert.deepEqual((await reviews.read(job, 0)).sessions, before.sessions);
    const consent = { researchDonation: true, consentedAt: "2026-09-01T00:00:00Z" };
    const batch = await reviews.donation(job, job.batches[0], consent, "0.2.0", 0);
    assert.equal(batch.group.count, 3);
    assert.deepEqual(batch.sessions[0].messages[0], message, "timestamps are included without opt-in");
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
    if (sent.length === 3) return new Response("Edge unavailable", { status: 520 });
    return new Response(JSON.stringify({ accepted: true, donation_id: crypto.randomUUID() }), { status: 200 });
  } });
  assert.equal(sent.length, 4);
  assert.ok(sent.every((init) => init.body === sent[0].body && init.headers["x-susan-calvin-deletion-token"] === "t".repeat(43)));
  assert.deepEqual(delays, [1000, 60000, 4000]);
});

test("stopping the local server cancels an in-flight upload without another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const donation = { donationRunId: crypto.randomUUID(), redactionMode: "standard", sessions: [{ source: "codex", messages: [message] }], consent: { researchDonation: true } };
  const pending = submitDonation(donation, "t".repeat(43), { signal: controller.signal, fetchImpl: async (_url, init) => {
    attempts++;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
  } });
  controller.abort();
  await assert.rejects(pending, /Upload stopped/);
  assert.equal(attempts, 1);
});


test("custom redaction only replaces matches with a fixed marker and preserves every turn", async () => {
  const reviews = new Reviews(catalog, { preview });
  const result = await reviews.create(["0"], { mode: "custom" });
  const job = reviews.get(result.id);
  try {
    await job.task;
    const result = await reviews.redact(job, 0, { pattern: "complete", type: "text", replacement: "Invented answer", messages: [] });
    assert.equal(result.count, 1);
    assert.deepEqual(result.preview.sessions[0].messages, [{ ...message, text: "Keep the [REDACTED CUSTOM] session" }, { role: "assistant", text: "Answer 0" }]);
    assert.deepEqual((await reviews.read(job, 0)).sessions, result.preview.sessions);
    await assert.rejects(reviews.redact(job, 0, { pattern: "(?=Keep)", type: "regex" }), /empty text/);
    const second = await reviews.redact(job, 0, { pattern: "Answer [0-9]+", type: "regex" });
    assert.equal(second.preview.sessions[0].messages[1].text, "[REDACTED CUSTOM]");
    assert.equal(second.preview.sessions[0].messages.length, 2);
    job.status = "uploading";
    await assert.rejects(reviews.redact(job, 0, { pattern: "Keep", type: "text" }), /finish/);
  } finally { await reviews.close(); }
});


test("replacing an automatic preview cancels pending preparation and removes its snapshot", async () => {
  let finishRead, started;
  const reading = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finishRead = resolve; });
  let reads = 0;
  const reviews = new Reviews(catalog, { preview: async (...args) => {
    reads++; started(); await gate; return preview(...args);
  } });
  const initial = await reviews.create([...catalog.index.keys()], { mode: "standard" });
  const old = reviews.get(initial.id);
  try {
    await reading;
    const cancelled = reviews.cancel(old);
    finishRead(); await cancelled;
    assert.equal(reads, 1, "obsolete selections stop after the current session");
    assert.equal(old.status, "cancelled");
    await assert.rejects(fs.stat(old.folder), { code: "ENOENT" });
    const latest = await reviews.create(["7"], { mode: "custom" });
    const job = reviews.get(latest.id); await job.task;
    assert.equal(job.status, "ready");
    assert.deepEqual(job.sessions.map(s => s.id), ["7"]);
    job.status = "uploading";
    await assert.rejects(reviews.cancel(job), /finish/);
    assert.equal(job.cancelled, undefined, "uploading snapshots cannot be cancelled by preview changes");
  } finally { await reviews.close(); }
});

test("the donation overview aggregates occurrences across every included session with bounded rule totals", async () => {
  const reviews = new Reviews(catalog, { preview: async (catalog, ids, options) => {
    const result = await preview(catalog, ids);
    const enabled = !options.unredacted && !options.disabledKinds.includes("email");
    result.redactions = options.unredacted ? [] : [{ kind: "email", label: "Email addresses", count: 2, enabledCount: enabled ? 2 : 0 }];
    result.detectionCount = enabled ? 2 : 0;
    return result;
  } });
  try {
    let result = await reviews.create([...catalog.index.keys()], { mode: "custom" });
    let job = reviews.get(result.id); await job.task;
    const summary = reviews.summary(job);
    assert.equal(summary.total, 501);
    assert.equal(summary.detections, 1002, "instances, not distinct values or sessions");
    assert.equal(summary.redactions.find(r => r.kind === "email").enabledCount, 1002);
    assert.equal(summary.redactions.find(r => r.kind === "phone").enabled, true);
    assert.equal(summary.redactions.find(r => r.kind === "phone").count, 0, "zero-match rules remain visible and active");
    assert.ok(JSON.stringify(summary.redactions).length < 2000, "aggregate metadata stays bounded with a large catalog");
    assert.ok(summary.redactions.every(r => !('matches' in r)), "the overview needs counts, not every private matched value");
    let changed = await reviews.redact(job, 0, { pattern: "complete", type: "text" });
    assert.equal(changed.overview.customDetections, 1);
    changed = await reviews.redact(job, 1, { pattern: "complete", type: "text" });
    assert.equal(changed.overview.customDetections, 2);
    const reset = await reviews.resetCustom(job, 0);
    assert.equal(reset.overview.customDetections, 1);
    assert.equal(reset.overview.detections, 1002, "resetting custom redactions leaves automatic totals intact");
    result = await reviews.create(["1", "2"], { mode: "custom", disabledKinds: ["email"] });
    job = reviews.get(result.id); await job.task;
    let current = reviews.summary(job);
    assert.deepEqual(current.redactions.find(r => r.kind === "email"), { kind: "email", label: "Email addresses", count: 4, enabledCount: 0, enabled: false });
    assert.equal(current.customDetections, 1, "custom counts are recalculated only for included sessions");
    result = await reviews.create(["2"], { mode: "custom" });
    job = reviews.get(result.id); await job.task; current = reviews.summary(job);
    assert.equal(current.detections, 2);
    assert.equal(current.customDetections, 0, "excluded sessions never contribute redactions");
    result = await reviews.create(["1", "2"], { mode: "unredacted" });
    job = reviews.get(result.id); await job.task; current = reviews.summary(job);
    assert.equal(current.detections + current.customDetections, 0);
    assert.ok(current.redactions.every(r => !r.enabled && r.enabledCount === 0));
  } finally { await reviews.close(); }
});
