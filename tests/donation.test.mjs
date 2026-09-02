import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decryptDonation, encryptDonation } from "../server/donation-crypto.mjs";
import { sanitizeDonation } from "../server/donation-schema.mjs";
import { submitDonation } from "../server/donation-client.mjs";
import { sanitizeEncryptedEnvelope } from "../server/encrypted-donation-schema.mjs";
import { discoverAllSessions, readSessionMessages } from "../server/discovery.mjs";
import { redactText } from "../server/privacy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(overrides = {}) {
  return {
    donationRunId: "11111111-1111-4111-8111-111111111111",
    collector: { version: "0.1.0" },
    redactionMode: "standard",
    createdAt: "2026-09-01T12:00:00.000Z",
    redactionSummary: { automatedDetections: 2 },
    sessions: [
      { sessionId: "local-id-must-disappear", label: "Private project", source: "codex", messages: [{ role: "user", text: "Reviewed prompt" }, { role: "assistant", text: "Reviewed answer" }] },
      { source: "claude", messages: [{ role: "user", text: "Second prompt", timestamp: "2026-09-01T11:00:00.000Z" }] },
    ],
    consent: { researchDonation: true, consentedAt: "2026-09-01T12:01:00.000Z" },
    ...overrides,
  };
}

let testKeys;
function keys() {
  testKeys ||= crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return testKeys;
}

test("the Susan Calvin schema strips local identifiers and preserves source types", () => {
  const donation = sanitizeDonation(fixture());
  assert.ok(donation);
  assert.equal(donation.format, "susan-calvin-donation-v1");
  assert.deepEqual(donation.sourceTypes, ["claude", "codex"]);
  assert.equal("sessionId" in donation.sessions[0], false);
  assert.equal("label" in donation.sessions[0], false);
  assert.equal(donation.consent.consentVersion, 1);
});

test("unredacted donations require their additional acknowledgement", () => {
  assert.equal(sanitizeDonation(fixture({ redactionMode: "unredacted" })), null);
  const donation = sanitizeDonation(fixture({ redactionMode: "unredacted", consent: { researchDonation: true, unredactedData: true, consentedAt: "2026-09-01T12:01:00.000Z" } }));
  assert.ok(donation);
  assert.equal(donation.redactionSummary.automatedDetections, 0);
  assert.match(donation.consent.statement, /not automatically redacted/i);
});

test("automatic redaction can be reviewed and selectively disabled", () => {
  const value = "Email me at person@example.com and use api_key=secret-value-12345.";
  const redacted = redactText(value);
  assert.equal(redacted.detections.length, 2);
  assert.doesNotMatch(redacted.text, /person@example\.com|secret-value/);
  const email = redacted.detections.find((item) => item.kind === "email");
  const customized = redactText(value, { disabledMatches: [email.matchId] });
  assert.match(customized.text, /person@example\.com/);
  assert.doesNotMatch(customized.text, /secret-value/);
});

test("reviewed text is compressed, encrypted locally, and authenticated", () => {
  const envelope = encryptDonation(fixture(), keys().publicKey);
  assert.ok(sanitizeEncryptedEnvelope(envelope));
  assert.equal(JSON.stringify(envelope).includes("Reviewed prompt"), false);
  assert.deepEqual(decryptDonation(envelope, keys().privateKey), sanitizeDonation(fixture()));
  const tampered = structuredClone(envelope);
  tampered.metadata.messages++;
  assert.throws(() => decryptDonation(tampered, keys().privateKey), /authenticate|invalid/i);
});

test("submission sends only the independent encrypted protocol", async () => {
  let transmitted;
  const result = await submitDonation(fixture(), "a".repeat(43), {
    endpoint: "https://example.test/v1/donations",
    fetchImpl: async (_url, init) => {
      transmitted = init;
      return new Response(JSON.stringify({ accepted: true, donation_id: "22222222-2222-4222-8222-222222222222" }), { status: 201 });
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(transmitted.headers["x-susan-calvin-protocol"], "1");
  assert.equal(transmitted.body.includes("Reviewed prompt"), false);
  assert.ok(sanitizeEncryptedEnvelope(JSON.parse(transmitted.body).encryptedDonation));
});

test("discovers and reads all supported demo session formats", async () => {
  const catalog = await discoverAllSessions({
    claudeRoot: path.join(root, "fixtures/claude"),
    coworkRoot: path.join(root, "fixtures/cowork"),
    codexRoots: [path.join(root, "fixtures/codex")],
    cache: false,
  });
  assert.deepEqual(new Set(catalog.sessions.map((session) => session.agent)), new Set(["claude", "cowork", "codex"]));
  for (const session of catalog.index.values()) {
    const messages = await readSessionMessages(session);
    assert.ok(messages.length >= 2);
    assert.ok(messages.every((message) => ["user", "assistant"].includes(message.role) && message.text));
  }
});

