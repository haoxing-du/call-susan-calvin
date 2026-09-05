import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { encryptDonation } from "../server/donation-crypto.mjs";
import { handleRequest } from "../worker/donation-worker.mjs";

const { publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function donation() {
  return encryptDonation({
    donationRunId: "33333333-3333-4333-8333-333333333333",
    collector: { version: "0.1.0" },
    redactionMode: "standard",
    createdAt: "2026-09-01T12:00:00.000Z",
    redactionSummary: { automatedDetections: 1 },
    sessions: [{ source: "codex", messages: [{ role: "user", text: "Private reviewed text" }] }],
    consent: { researchDonation: true, consentedAt: "2026-09-01T12:01:00.000Z" },
  }, publicKey);
}

test("the receiver stores ciphertext separately from minimal metadata", async () => {
  let storedObject;
  let inserted;
  const database = {
    prepare(sql) { return { bind(...values) { return {
      async first() { return null; },
      async run() { if (sql.startsWith("INSERT INTO susan_calvin_donations")) inserted = { sql, values }; return { success: true }; },
    }; } }; },
  };
  const bucket = { async put(key, value) { storedObject = { key, value }; }, async delete() {} };
  const response = await handleRequest(new Request("https://donate.example/v1/donations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": "d".repeat(43) },
    body: JSON.stringify({ encryptedDonation: donation() }),
  }), { DONATION_METADATA: database, DONATIONS: bucket });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.donation_id, /^[0-9a-f-]{36}$/);
  assert.match(storedObject.key, /^donations\/2026-09\//);
  assert.equal(storedObject.value.includes("Private reviewed text"), false);
  assert.match(inserted.sql, /^INSERT INTO susan_calvin_donations/);
  assert.equal(inserted.values.some((value) => String(value).includes("Private reviewed text")), false);
  assert.equal(inserted.values.includes("d".repeat(43)), false);
});

test("retries are idempotent when they use the same local deletion token", async () => {
  const token = "e".repeat(43);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let put = false;
  const database = { prepare() { return { bind() { return { async run() { return { success: true }; }, async first() { return { id: "44444444-4444-4444-8444-444444444444", deletion_token_hash: tokenHash }; } }; } }; } };
  const response = await handleRequest(new Request("https://donate.example/v1/donations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": token },
    body: JSON.stringify({ encryptedDonation: donation() }),
  }), { DONATION_METADATA: database, DONATIONS: { async put() { put = true; } } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(put, false);
});

test("a deletion receipt removes ciphertext and metadata", async () => {
  const deleted = [];
  const database = {
    prepare(sql) { return { bind(...values) { return {
      async first() { return { object_key: "donations/2026-09/example.json" }; },
      async run() { deleted.push({ sql, values }); return { success: true }; },
    }; } }; },
  };
  const response = await handleRequest(new Request("https://donate.example/v1/donations/55555555-5555-4555-8555-555555555555", {
    method: "DELETE",
    headers: { "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": "f".repeat(43) },
  }), { DONATION_METADATA: database, DONATIONS: { async delete(key) { deleted.push({ key }); } } });
  assert.equal(response.status, 200);
  assert.equal(deleted[0].key, "donations/2026-09/example.json");
  assert.match(deleted[1].sql, /^DELETE FROM susan_calvin_donations/);
});

test("the receiver rejects plaintext and unsupported protocols", async () => {
  const response = await handleRequest(new Request("https://donate.example/v1/donations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-susan-calvin-protocol": "0", "x-susan-calvin-deletion-token": "g".repeat(43) },
    body: JSON.stringify({ donation: { sessions: [] } }),
  }), {});
  assert.equal(response.status, 426);
  const plaintext = await handleRequest(new Request("https://donate.example/v1/donations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": "g".repeat(43) },
    body: JSON.stringify({ donation: { sessions: [] } }),
  }), { DONATION_METADATA: { prepare() { throw new Error("plaintext must be rejected first"); } }, DONATIONS: {} });
  assert.equal(plaintext.status, 400);
});
