import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReceiver } from "./helpers/receiver.mjs";
import { submitDonation, deleteDonation } from "../server/donation-client.mjs";
import { getContributorId } from "../server/store.mjs";
import { encryptDonation, decryptDonation } from "../server/donation-crypto.mjs";
import { sanitizeEncryptedEnvelope } from "../server/encrypted-donation-schema.mjs";
import { countTranscriptTokens } from "../server/transcript-tokens.mjs";
import { publicStats } from "../worker/stats.mjs";

const sample = () => ({ donationRunId: crypto.randomUUID(), redactionMode: "standard", sessions: [{ source: "codex", messages: [{ role: "user", text: "Hello world" }] }], consent: { researchDonation: true } });

test("contributor identity survives restarts and is private and independent of receipts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "susan-identity-"));
  try {
    const id = getContributorId(root);
    assert.equal(getContributorId(root), id);
    assert.equal((await fs.stat(path.join(root, "contributor-id"))).mode & 0o777, 0o600);
    assert.equal((await import(`../server/store.mjs?restart=${Date.now()}`)).getContributorId(root), id);
    await fs.writeFile(path.join(root, "contributor-id"), "invalid");
    assert.throws(() => getContributorId(root), /invalid/);
    await fs.unlink(path.join(root, "contributor-id"));
    assert.notEqual(getContributorId(root), id);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("tokens count shared text and optional envelope fields remain authenticated and compatible", () => {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
  const donation = { ...sample(), contributorId: crypto.randomUUID() };
  const envelope = encryptDonation(donation, keys.publicKey);
  assert.equal(envelope.metadata.tokens, 2);
  assert.equal(envelope.metadata.contributorId, donation.contributorId);
  assert.equal(decryptDonation(envelope, keys.privateKey).contributorId, donation.contributorId);
  const old = structuredClone(envelope);
  delete old.metadata.tokens; delete old.metadata.tokenEncoding; delete old.metadata.contributorId;
  assert.ok(sanitizeEncryptedEnvelope(old));
  for (const field of ["tokens", "contributorId"]) {
    const tampered = structuredClone(envelope);
    tampered.metadata[field] = field === "tokens" ? 3 : crypto.randomUUID();
    assert.throws(() => decryptDonation(tampered, keys.privateKey));
  }
  for (const tokens of [-1, 1.5, 20_000_001]) assert.equal(sanitizeEncryptedEnvelope({ ...envelope, metadata: { ...envelope.metadata, tokens } }), null);
  assert.ok(countTranscriptTokens({ sessions: [{ messages: [{ text: "你好 <|endoftext|>" }] }] }) > 0);
});

test("public totals deduplicate donors and batches, exclude partial/deleted donations, and preserve unknown tokens", async () => {
  const { mf, db } = await createReceiver();
  try {
    const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    const options = { publicKey: keys.publicKey, endpoint: "https://test/v1/donations", fetchImpl: (url, init) => mf.dispatchFetch(url, init), sleep: async () => {}, attempts: 1 };
    const contributorId = crypto.randomUUID(), token = crypto.randomBytes(32).toString("base64url"), id = crypto.randomUUID();
    const batches = [0, 1].map(index => ({ ...sample(), contributorId, group: { id, index, count: 2 } }));
    const stats = async () => { const response = await mf.dispatchFetch("https://test/v1/stats"); assert.equal(response.status, 200); const { updatedAt, ...counts } = await response.json(); assert.ok(Date.parse(updatedAt)); return counts; };
    assert.deepEqual(await stats(), { contributors: 0, sessions: 0, tokens: 0 });
    await submitDonation(batches[0], token, options);
    assert.deepEqual(await stats(), { contributors: 0, sessions: 0, tokens: 0 });
    await assert.rejects(submitDonation({ ...batches[1], contributorId: crypto.randomUUID() }, token, options), /does not match/);
    await submitDonation(batches[1], token, options);
    await submitDonation(batches[0], token, options);
    assert.deepEqual(await stats(), { contributors: 1, sessions: 2, tokens: 4 });
    const second = await submitDonation({ ...sample(), contributorId }, token, options);
    const anonymous = await submitDonation(sample(), token, options);
    assert.deepEqual(await stats(), { contributors: 2, sessions: 4, tokens: 8 });
    await db.prepare("UPDATE susan_calvin_donations SET token_count = NULL WHERE id = ?").bind(anonymous.donation_id).run();
    assert.deepEqual(await stats(), { contributors: 2, sessions: 4, tokens: null });
    await deleteDonation(id, token, { ...options, group: true });
    assert.equal((await db.prepare("SELECT contributor_id FROM susan_calvin_donation_groups WHERE id = ?").bind(id).first()).contributor_id, null);
    assert.deepEqual(await stats(), { contributors: 2, sessions: 2, tokens: null });
    await deleteDonation(second.donation_id, token, options);
    assert.deepEqual(await stats(), { contributors: 1, sessions: 1, tokens: null });
    await deleteDonation(anonymous.donation_id, token, options);
    assert.deepEqual(await stats(), { contributors: 0, sessions: 0, tokens: 0 });
    const body = await (await publicStats({ DONATION_METADATA: db, LEGACY_RESEARCH_DB: { prepare() { return { first: async () => ({ contributors: 7, sessions: 790, tokens: 1000, missing_tokens: 0 }) }; } } })).json();
    assert.equal(body.contributors, 7); assert.equal(body.tokens, 1000);
    assert.equal((await publicStats({})).status, 503);
  } finally { await mf.dispose(); }
});
