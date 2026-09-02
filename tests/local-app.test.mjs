import assert from "node:assert/strict";
import test from "node:test";
import { startLocalApp } from "../server/launcher.mjs";

test("the demo review stays local and builds an exact preview", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  try {
    const catalog = await (await fetch(`${local.url}/api/catalog`)).json();
    assert.equal(catalog.demo, true);
    assert.equal(catalog.sessions.length, 3);
    const response = await fetch(`${local.url}/api/donation-preview`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: local.url },
      body: JSON.stringify({ sessionIds: catalog.sessions.map((session) => session.id), mode: "standard" }),
    });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.createdLocally, true);
    assert.equal(preview.sessions.length, 3);
    assert.ok(preview.detectionCount >= 2);
    assert.equal(JSON.stringify(preview).includes("researcher@example.com"), true, "local review exposes matched values so donors can inspect them");
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
});

test("mutating localhost APIs reject requests from other origins", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  try {
    const response = await fetch(`${local.url}/api/donation-preview`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(response.status, 403);
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
});

test("demo donations exercise consent validation without transmitting", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  try {
    const donation = {
      donationRunId: "88888888-8888-4888-8888-888888888888",
      redactionMode: "standard",
      createdAt: "2026-09-01T12:00:00.000Z",
      redactionSummary: { automatedDetections: 0 },
      sessions: [{ source: "codex", messages: [{ role: "user", text: "Synthetic local demo text" }] }],
      consent: { researchDonation: true, consentedAt: "2026-09-01T12:01:00.000Z" },
    };
    const response = await fetch(`${local.url}/api/donations`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: local.url },
      body: JSON.stringify({ donation }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { accepted: true, donationId: "demo-not-transmitted", demo: true });
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
});
