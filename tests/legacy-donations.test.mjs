import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deleteLegacyDonation } from "../worker/legacy-donations.mjs";

test("legacy receipt management preserves receipts on failure and handles lost acknowledgements", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "susan-legacy-"));
  process.env.BEHAVIOR_WRAPPED_STORE_ROOT = path.join(root, "wrapped");
  process.env.CALL_SUSAN_CALVIN_STORE_ROOT = path.join(root, "susan");
  const { listManagedDonations, deleteManagedDonation } = await import("../server/managed-donations.mjs");
  const { saveDonationReceipt } = await import("../server/store.mjs");
  const receipts = path.join(process.env.BEHAVIOR_WRAPPED_STORE_ROOT, "donation-receipts");
  fs.mkdirSync(receipts, { recursive: true });
  const id = crypto.randomUUID(), token = "x".repeat(43), file = path.join(receipts, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ donationId: id, deletionToken: token, savedAt: "2026-09-08" }));
  try {
    assert.equal(listManagedDonations()[0].origin, "wrapped");
    assert.equal(listManagedDonations()[0].sessionCount, undefined);
    await assert.rejects(deleteManagedDonation(id, { fetchImpl: async () => Response.json({ error: "Offline" }, { status: 503 }) }), /Offline/);
    assert.ok(fs.existsSync(file));
    await assert.rejects(deleteManagedDonation(id, { fetchImpl: async () => Response.json({ error: "Unknown route" }, { status: 404 }) }));
    assert.ok(fs.existsSync(file));
    saveDonationReceipt({ donationId: id, deletionToken: token, group: true });
    await assert.rejects(deleteManagedDonation(id), /Both apps/);
    await deleteManagedDonation(`wrapped:${id}`, { fetchImpl: async (url, options) => {
      assert.equal(url, `https://behaviorwrapped.com/v1/research-donations/${id}`);
      assert.equal(options.headers["x-behavior-wrapped-deletion-token"], token);
      return Response.json({ error: "Donation not found." }, { status: 404 });
    } });
    assert.equal(fs.existsSync(file), false);
    await deleteManagedDonation(`susan:${id}`, { deleteSusan: async (receivedId, receivedToken, options) => {
      assert.equal(receivedId, id); assert.equal(receivedToken, token); assert.equal(options.group, true);
    } });
    assert.deepEqual(listManagedDonations(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy receiver authenticates before removing ciphertext and then metadata", async () => {
  const events = [];
  const env = {
    LEGACY_RESEARCH_DB: { prepare(sql) { return { bind(...values) { return {
      async first() { assert.match(values[1], /^[a-f0-9]{64}$/); events.push("auth"); return { object_key: "legacy-object" }; },
      async run() { assert.match(sql, /^DELETE/); events.push("metadata"); },
    }; } }; } },
    LEGACY_RESEARCH_DONATIONS: { async delete(key) { assert.equal(key, "legacy-object"); events.push("object"); } },
  };
  const request = new Request("https://example.test", { headers: { "x-behavior-wrapped-deletion-token": "x".repeat(43) } });
  assert.equal((await deleteLegacyDonation(new Request("https://example.test"), env, crypto.randomUUID())).status, 400);
  assert.deepEqual(events, []);
  assert.equal((await deleteLegacyDonation(request, env, crypto.randomUUID())).status, 200);
  assert.deepEqual(events, ["auth", "object", "metadata"]);
  events.length = 0;
  env.LEGACY_RESEARCH_DONATIONS.delete = async () => { throw new Error("Offline"); };
  assert.equal((await deleteLegacyDonation(request, env, crypto.randomUUID())).status, 503);
  assert.deepEqual(events, ["auth"]);
});
