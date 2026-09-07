import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { Reviews, planBatches } from "../server/reviews.mjs";
import { encryptDonation, decryptDonation } from "../server/donation-crypto.mjs";
import { submitDonation } from "../server/donation-client.mjs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

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
    await assert.rejects(reviews.redact(job, { pattern: "complete", type: "text" }), /Customize redactions/);
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
    const result = await reviews.redact(job, { pattern: "complete", type: "text", replacement: "Invented answer", messages: [] });
    assert.equal(result.count, 1);
    assert.deepEqual((await reviews.read(job, 0)).sessions[0].messages, [{ ...message, text: "Keep the [REDACTED] session" }, { role: "assistant", text: "Answer 0" }]);

    await assert.rejects(reviews.redact(job, { pattern: "(?=Keep)", type: "regex" }), /empty text/);
    const second = await reviews.redact(job, { pattern: "Answer [0-9]+", type: "regex" });
    assert.equal((await reviews.read(job, 0)).sessions[0].messages[1].text, "[REDACTED]");
    assert.equal((await reviews.read(job, 0)).sessions[0].messages.length, 2);
    job.status = "uploading";
    await assert.rejects(reviews.redact(job, { pattern: "Keep", type: "text" }), /finish/);
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
    let changed = await reviews.redact(job, { pattern: "complete", type: "text" });
    assert.equal(changed.overview.customDetections, 501);
    changed = await reviews.redact(job, { pattern: "complete", type: "text" });
    assert.equal(changed.overview.customDetections, 501);
    const reset = await reviews.resetCustom(job);
    assert.equal(reset.overview.customDetections, 0);
    assert.equal(reset.overview.detections, 1002, "resetting custom redactions leaves automatic totals intact");
    await reviews.redact(job, { pattern: "complete", type: "text" });
    result = await reviews.create(["1", "2"], { mode: "custom", disabledKinds: ["email"] });
    job = reviews.get(result.id); await job.task;
    let current = reviews.summary(job);
    assert.deepEqual(current.redactions.find(r => r.kind === "email"), { kind: "email", label: "Email addresses", count: 4, enabledCount: 0, enabled: false });
    assert.equal(current.customDetections, 2, "custom counts are recalculated only for included sessions");
    result = await reviews.create(["2"], { mode: "custom" });
    job = reviews.get(result.id); await job.task; current = reviews.summary(job);
    assert.equal(current.detections, 2);
    assert.equal(current.customDetections, 1, "excluded sessions never contribute redactions");
    result = await reviews.create(["1", "2"], { mode: "unredacted" });
    job = reviews.get(result.id); await job.task; current = reviews.summary(job);
    assert.equal(current.detections + current.customDetections, 0);
    assert.ok(current.redactions.every(r => !r.enabled && r.enabledCount === 0));
  } finally { await reviews.close(); }
});

test("category strings combine all included sessions without truncation or leaking into summary polling", async () => {
  const longValue = "long-".repeat(90) + "@example.com";
  const reviews = new Reviews(catalog, { preview: async (catalog, ids, options) => {
    const result = await preview(catalog, ids);
    const matches = [
      { id: "shared", value: "shared@example.com", count: 2, enabled: !options.disabledMatches.includes("shared") },
      { id: ids[0], value: ids[0] === "0" ? longValue : `${ids[0]}@example.com`, count: 1, enabled: true },
    ];
    if (options.disabledKinds.includes("email")) matches.forEach(m => { m.enabled = false; });
    result.redactions = options.unredacted ? [] : [{ kind: "email", label: "Email addresses", count: 3, enabledCount: matches.reduce((n, m) => n + (m.enabled ? m.count : 0), 0), matches }];
    result.detectionCount = result.redactions[0]?.enabledCount || 0;
    return result;
  } });
  async function prepare(ids, options = {}) {
    const result = await reviews.create(ids, { mode: "custom", ...options });
    const job = reviews.get(result.id); await job.task; return job;
  }
  try {
    let job = await prepare([...catalog.index.keys()]);
    let category = await reviews.matches(job, "email");
    assert.equal(category.matches.length, 502);
    assert.equal(category.matches[0].value, "shared@example.com");
    assert.equal(category.matches[0].count, 1002);
    assert.equal(category.matches.find(m => m.id === "0").value, longValue);
    assert.equal(category.matches.reduce((n, m) => n + m.count, 0), category.count);
    assert.ok(!JSON.stringify(reviews.summary(job)).includes("shared@example.com"));
    assert.deepEqual((await reviews.matches(job, "phone")).matches, []);
    await assert.rejects(reviews.matches(job, "unknown"), /category/);
    await assert.rejects(reviews.matches(job, "email", () => true), /Review changed/);
    job = await prepare(["0", "1"], { disabledMatches: ["shared"] });
    category = await reviews.matches(job, "email");
    assert.equal(category.matches.length, 3);
    assert.equal(category.matches[0].count, 4);
    assert.equal(category.matches[0].enabled, false);
    assert.equal(category.enabledCount, 2);
    job = await prepare(["1"], { disabledKinds: ["email"] });
    category = await reviews.matches(job, "email");
    assert.equal(category.matches.length, 2);
    assert.ok(category.matches.every(m => !m.enabled));
    job = await prepare(["1"], { mode: "unredacted" });
    assert.deepEqual((await reviews.matches(job, "email")).matches, []);
  } finally { await reviews.close(); }
});

test("occurrences locate every match across messages and sessions, stay local, and survive redaction choices", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "susan-occurrences-test-"));
  const number = "4242424242424242";
  const index = new Map();
  for (const id of ["a", "b"]) {
    const file = path.join(root, `${id}.jsonl`);
    const messages = Array.from({ length: 46 }, (_, i) => ({ type: "user", message: { content: `Message ${i + 1}` } }));
    messages[45].message.content = `${id}: invoice ${number} followed by another ${number}.`;
    await fs.writeFile(file, messages.map(m => JSON.stringify(m)).join("\n"));
    index.set(id, { file, agent: "claude", agentName: "Claude Code", startedAt: "2026-09-01" });
  }
  const reviews = new Reviews({ index }, { root });
  async function prepare(ids, options = {}) {
    const result = await reviews.create(ids, { mode: "custom", ...options });
    const job = reviews.get(result.id); await job.task;
    assert.equal(job.status, "ready"); return job;
  }
  try {
    let job = await prepare(["a", "b"]);
    const match = (await reviews.matches(job, "payment-number")).matches[0];
    assert.equal(match.count, 4);
    const places = await Promise.all([0, 1, 2, 3].map(i => reviews.occurrence(job, "payment-number", match.id, i)));
    assert.deepEqual(places.map(p => p.sessionId), ["a", "a", "b", "b"]);
    assert.ok(places.every(p => p.messageIndex === 45 && p.total === 4 && p.value === number));
    assert.match(places[0].before, /a: invoice $/);
    assert.match(places[1].before, /followed by another $/);
    await assert.rejects(reviews.occurrence(job, "payment-number", match.id, 4), /not found/);
    await assert.rejects(reviews.occurrence(job, "payment-number", match.id, -1), /available/);
    await assert.rejects(reviews.occurrence(job, "payment-number", match.id, 0, () => true), /changed/);
    const donation = await reviews.donation(job, [0, 1], { researchDonation: true }, "test", 0);
    assert.doesNotMatch(JSON.stringify(donation), /locations|invoice 4242424242424242/);
    await reviews.redact(job, { pattern: "invoice", type: "text" });
    assert.equal((await reviews.occurrence(job, "payment-number", match.id)).messageIndex, 45);
    job = await prepare(["b"], { disabledMatches: [match.id] });
    const disabled = await reviews.occurrence(job, "payment-number", match.id, 1);
    assert.equal(disabled.total, 2); assert.equal(disabled.sessionId, "b"); assert.equal(disabled.enabled, false);
    const snapshot = await reviews.read(job, 0);
    assert.match(snapshot.sessions[0].messages[45].text, /4242424242424242/);
    await fs.writeFile(index.get("b").file, "");
    assert.deepEqual(await reviews.occurrence(job, "payment-number", match.id, 1), disabled, "locations describe the reviewed snapshot, not later source changes");
  } finally { await reviews.close(); await fs.rm(root, { recursive: true, force: true }); }
});


test("global patterns cover later inclusions, reset snapshots exactly, and roll back a failure in a later session", async () => {
  let changed = false;
  const reviews = new Reviews(catalog, { preview: async (_catalog, [id]) => ({ detectionCount: 0, redactions: [], sessions: [{ sessionId: id, source: "codex", label: id, messages: [{ ...message, text: changed ? "Changed source" : id === "1" ? "bad" : "complete" }] }] }) });
  const prepare = async ids => { const result = await reviews.create(ids, { mode: "custom" }); const job = reviews.get(result.id); await job.task; return job; };
  try {
    let job = await prepare(["0"]);
    await reviews.redact(job, { pattern: "complete", type: "text" });
    job = await prepare(["0", "2"]);
    assert.equal(job.customDetections, 2, "newly included sessions inherit rules");
    changed = true;
    await reviews.resetCustom(job);
    assert.equal((await reviews.read(job, 1)).sessions[0].messages[0].text, "complete", "reset uses the reviewed source snapshot");
    assert.equal(reviews.customRedactionCount(), 0);
    changed = false;
    job = await prepare(["0", "1"]);
    const folder = job.folder;
    await assert.rejects(reviews.redact(job, { pattern: "complete|(?=bad)", type: "regex" }), /empty text/);
    assert.equal(job.folder, folder);
    assert.equal(job.redacting, false);
    assert.equal(job.customDetections, 0);
    assert.equal(reviews.customRedactionCount(), 0);
    assert.equal((await reviews.read(job, 0)).sessions[0].messages[0].text, "complete", "earlier sessions are unchanged after a later failure");
    await reviews.redact(job, { pattern: "later", type: "text" });
    assert.equal(reviews.customRedactionCount(), 1, "zero-match rules are saved for later inclusions");
  } finally { await reviews.close(); }
});

test("custom rules have stable identities and counts; removing one replays the others across every snapshot", async () => {
  let sourceChanged = false;
  const reviews = new Reviews(catalog, { preview: async (...args) => {
    const result = await preview(...args);
    if (sourceChanged) result.sessions[0].messages = [{ role: "user", text: "Changed source" }];
    return result;
  } });
  const prepare = async (ids, mode = "custom") => { const result = await reviews.create(ids, { mode }); const job = reviews.get(result.id); await job.task; return job; };
  try {
    let job = await prepare(["0", "1"]);
    await reviews.redact(job, { pattern: "complete", type: "text" });
    await reviews.redact(job, { pattern: "complete session", type: "text" });
    await reviews.redact(job, { pattern: "Answer [0-9]+", type: "regex" });
    const rules = reviews.summary(job).customRules;
    assert.deepEqual(rules.map(({ pattern, type, count, enabled }) => ({ pattern, type, count, enabled })), [
      { pattern: "complete", type: "text", count: 2, enabled: true },
      { pattern: "complete session", type: "text", count: 0, enabled: true },
      { pattern: "Answer [0-9]+", type: "regex", count: 2, enabled: true },
    ]);
    assert.equal(new Set(rules.map(rule => rule.id)).size, 3);
    sourceChanged = true;
    await reviews.removeCustom(job, rules[0].id);
    assert.deepEqual(reviews.summary(job).customRules.map(({ id, count }) => ({ id, count })), rules.slice(1).map(rule => ({ id: rule.id, count: 2 })));
    for (const i of [0, 1]) assert.deepEqual((await reviews.read(job, i)).sessions[0].messages, [{ ...message, text: "Keep the [REDACTED]" }, { role: "assistant", text: "[REDACTED]" }]);
    assert.equal(job.customDetections, 4);
    await assert.rejects(reviews.removeCustom(job, rules[0].id), /not found/);
    sourceChanged = false;
    job = await prepare(["2"]);
    assert.deepEqual(reviews.summary(job).customRules.map(rule => [rule.id, rule.count]), rules.slice(1).map(rule => [rule.id, 1]));
    const donation = await reviews.donation(job, [0], { researchDonation: true }, "test", 0);
    assert.doesNotMatch(JSON.stringify(donation), /customRules|complete session|Answer \[0-9\]/);
    job = await prepare(["2"], "standard");
    assert.ok(reviews.summary(job).customRules.every(rule => !rule.enabled && rule.count === 0));
    await assert.rejects(reviews.removeCustom(job, rules[1].id), /Customize/);
    job = await prepare(["2"]);
    await reviews.removeCustom(job, rules[1].id);
    assert.equal((await reviews.read(job, 0)).sessions[0].messages[0].text, message.text);
    assert.equal((await reviews.read(job, 0)).sessions[0].messages[1].text, "[REDACTED]");
    await reviews.removeCustom(job, rules[2].id);
    assert.deepEqual(reviews.summary(job).customRules, []);
    assert.equal(job.customDetections, 0);
  } finally { await reviews.close(); }
});

test("removing a rule rolls back if it exposes text that makes a remaining expression invalid", async () => {
  const reviews = new Reviews(catalog, { preview });
  const result = await reviews.create(["0", "1"], { mode: "custom" });
  const job = reviews.get(result.id); await job.task;
  try {
    await reviews.redact(job, { pattern: "complete", type: "text" });
    await reviews.redact(job, { pattern: "Answer|(?=complete)", type: "regex" });
    const before = await reviews.read(job, 0), summary = reviews.overview(job);
    await assert.rejects(reviews.removeCustom(job, summary.customRules[0].id), /empty text/);
    assert.deepEqual(await reviews.read(job, 0), before);
    assert.deepEqual(reviews.overview(job), summary);
    assert.equal(job.redacting, false);
  } finally { await reviews.close(); }
});

test("custom occurrences preserve every actual regex match across pages and sessions without uploading context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "susan-custom-locations-"));
  const index = new Map();
  for (const id of ["a", "b"]) {
    const file = path.join(root, `${id}.jsonl`);
    const messages = Array.from({ length: 46 }, (_, i) => ({ type: "user", message: { content: `Message ${i + 1}` } }));
    messages[45].message.content = `${id}: invoice ID-42 then ID-99\nagain ID-42`;
    await fs.writeFile(file, messages.map(message => JSON.stringify(message)).join("\n"));
    index.set(id, { file, agent: "claude", agentName: "Claude Code", startedAt: "2026-09-01" });
  }
  const reviews = new Reviews({ index }, { root });
  const prepare = async (ids, mode = "custom") => {
    const result = await reviews.create(ids, { mode }); const job = reviews.get(result.id); await job.task;
    assert.equal(job.status, "ready"); return job;
  };
  try {
    let job = await prepare(["a", "b"]);
    await reviews.redact(job, { pattern: "invoice", type: "text" });
    await reviews.redact(job, { pattern: "(?<prefix>ID)-(?<number>\\d+)", type: "regex" });
    const [literal, regex] = reviews.summary(job).customRules;
    assert.equal((await reviews.occurrence(job, "custom", literal.id)).value, "invoice");
    const places = await Promise.all(Array.from({ length: 6 }, (_, position) => reviews.occurrence(job, "custom", regex.id, position)));
    assert.deepEqual(places.map(place => place.value), ["ID-42", "ID-99", "ID-42", "ID-42", "ID-99", "ID-42"]);
    assert.deepEqual(places.map(place => place.sessionId), ["a", "a", "a", "b", "b", "b"]);
    assert.ok(places.every(place => place.total === 6 && place.messageIndex === 45 && place.enabled && place.pattern === regex.pattern));
    assert.equal(places[0].before, "a: [REDACTED] ");
    assert.equal(places[1].after, "\nagain ID-42");
    assert.equal(places[2].before, "a: [REDACTED] ID-42 then ID-99\nagain ");
    await assert.rejects(reviews.occurrence(job, "custom", regex.id, 6), /not found/);
    await assert.rejects(reviews.occurrence(job, "custom", regex.id, -1), /available/);
    await assert.rejects(reviews.occurrence(job, "custom", regex.id, 0.5), /available/);
    await assert.rejects(reviews.occurrence(job, "custom", regex.id, 0, () => true), /changed/);
    assert.doesNotMatch(JSON.stringify(reviews.summary(job)), /ID-42|locations|messageIndex/);
    const donation = await reviews.donation(job, [0, 1], { researchDonation: true }, "test", 0);
    assert.doesNotMatch(JSON.stringify(donation), /ID-42|ID-99|locations|customRules|invoice/);
    await fs.writeFile(index.get("a").file, "");
    assert.deepEqual(await reviews.occurrence(job, "custom", regex.id, 0), places[0]);
    await reviews.removeCustom(job, literal.id);
    assert.equal((await reviews.occurrence(job, "custom", regex.id)).before, "a: invoice ", "locations rebuild from the snapshot after removing an earlier rule");
    job = await prepare(["b"]);
    assert.equal((await reviews.occurrence(job, "custom", regex.id)).total, 3);
    await reviews.redact(job, { pattern: "no matches here", type: "text" });
    const empty = reviews.summary(job).customRules.at(-1);
    await assert.rejects(reviews.occurrence(job, "custom", empty.id), /No applied occurrences/);
    job = await prepare(["b"], "standard");
    await assert.rejects(reviews.occurrence(job, "custom", regex.id), /No applied occurrences/);
    job = await prepare(["b"]);
    await reviews.removeCustom(job, regex.id);
    await assert.rejects(reviews.occurrence(job, "custom", regex.id), /No applied occurrences/);
  } finally { await reviews.close(); await fs.rm(root, { recursive: true, force: true }); }
});
