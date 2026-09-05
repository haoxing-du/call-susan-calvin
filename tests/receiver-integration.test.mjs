import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createReceiver } from "./helpers/receiver.mjs";
import { submitDonation, deleteDonation } from "../server/donation-client.mjs";
import { deliverNotifications, reconcileNotifications } from "../worker/notifications.mjs";

const waitFor = async (read, expected) => {
  for (let i = 0; i < 100; i++) { const result = await read(); if (result === expected) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.equal(await read(), expected);
};

test("real Worker, D1 and R2 accept a group once, notify once, and delete the entire group", async () => {
  const { mf, db, bucket } = await createReceiver();
  try {
    const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString("base64url");
    const options = { endpoint: "https://test/v1/donations", fetchImpl: (url, init) => mf.dispatchFetch(url, init), sleep: async () => {} };
    const make = (index) => ({ donationRunId: `${id.slice(0, -1)}${index}`, group: { id, index, count: 3 }, redactionMode: "standard", sessions: [{ source: "codex", messages: [{ role: "user", text: `Synthetic batch ${index}` }] }], consent: { researchDonation: true } });
    const first = await submitDonation(make(0), token, options);
    assert.equal((await submitDonation(make(0), token, options)).donation_id, first.donation_id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM test_deliveries").first()).n, 0);
    await assert.rejects(submitDonation(make(1), "x".repeat(43), options), /does not match/);
    await submitDonation(make(1), token, options);
    await submitDonation(make(2), token, options);
    await waitFor(async () => (await db.prepare("SELECT COUNT(*) AS n FROM test_deliveries").first()).n, 1);
    await submitDonation(make(2), token, options);
    const row = await db.prepare("SELECT payload FROM test_deliveries").first();
    assert.deepEqual(JSON.parse(row.payload), { sessions: 3, messages: 3, automatedDetections: 0, redactionMode: "standard" });
    assert.equal((await bucket.list()).objects.length, 3);
    await db.prepare("DELETE FROM susan_calvin_notifications WHERE id = ?").bind(id).run();
    await reconcileNotifications({ DONATION_METADATA: db });
    const recovered = await db.prepare("SELECT payload FROM susan_calvin_notifications WHERE id = ?").bind(id).first();
    assert.equal(JSON.parse(recovered.payload).messages, 3);
    // Recovery creates an outbox entry even if the process stopped just after storage.

    await deleteDonation(id, token, { ...options, group: true });
    assert.equal((await bucket.list()).objects.length, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM susan_calvin_donations").first()).n, 0);
    await assert.rejects(submitDonation(make(0), token, options), /does not match/);
  } finally { await mf.dispose(); }
});

test("notification failures remain queued and simultaneous retries claim only one delivery", async () => {
  const { mf, db } = await createReceiver();
  try {
    await db.prepare("INSERT INTO susan_calvin_notifications (id, payload) VALUES ('test', '{}')").run();
    let attempts = 0;
    const env = { DONATION_METADATA: db, ZULIP_NOTIFIER: { async notifyDonation() { attempts++; if (attempts === 1) throw new Error("Temporary failure"); return { sent: true }; } } };
    await deliverNotifications(env);
    assert.equal((await db.prepare("SELECT delivered_at FROM susan_calvin_notifications").first()).delivered_at, null);
    await Promise.all([deliverNotifications(env), deliverNotifications(env)]);
    assert.equal(attempts, 2);
    assert.ok((await db.prepare("SELECT delivered_at FROM susan_calvin_notifications").first()).delivered_at);
  } finally { await mf.dispose(); }
});
