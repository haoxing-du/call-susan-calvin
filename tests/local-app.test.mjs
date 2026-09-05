import assert from "node:assert/strict";
import test from "node:test";
import { startLocalApp } from "../server/launcher.mjs";

test("the demo review stays local and builds an exact preview", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  try {
    const catalog = await (await fetch(`${local.url}/api/catalog`)).json();
    assert.equal(catalog.demo, true);
    assert.equal(catalog.sessions.length, 3);
    const cowork = catalog.sessions.find((session) => session.agent === "cowork");
    assert.equal(cowork.agentName, "Claude Cowork");
    assert.equal(cowork.title, "Research update");
    assert.equal(cowork.firstUserMessage, "Draft a concise research update.");
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
    donation.sessions[0].messages[0].text = "   ";
    const blankResponse = await fetch(`${local.url}/api/donations`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: local.url },
      body: JSON.stringify({ donation }),
    });
    assert.equal(blankResponse.status, 400, "an empty message must not be silently excluded");
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
});

test("paged review uploads only after consent and the success action stops the listener", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  const call = async (route, method = "GET", body) => fetch(`${local.url}${route}`, { method, headers: { origin: local.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call("/api/shutdown", "POST")).status, 409);
    const catalog = await (await call("/api/catalog")).json();
    const job = await (await call("/api/reviews", "POST", { sessionIds: catalog.sessions.map((s) => s.id), mode: "standard" })).json();
    let status;
    do { status = await (await call(`/api/reviews/${job.id}`)).json(); } while (status.status === "preparing");
    assert.equal(status.status, "ready");
    assert.equal(status.sessions.length, 3);
    const preview = await (await call(`/api/reviews/${job.id}/sessions/0`)).json();
    assert.equal(preview.sessions.length, 1);
    assert.equal((await call(`/api/reviews/${job.id}/donate`, "POST", {})).status, 400);
    assert.equal((await call(`/api/reviews/${job.id}/donate`, "POST", { researchDonation: true })).status, 202);
    do { status = await (await call(`/api/reviews/${job.id}`)).json(); } while (status.status === "uploading");
    assert.equal(status.status, "complete");
    const blocked = await fetch(`${local.url}/api/shutdown`, { method: "POST", headers: { origin: "https://attacker.example" } });
    assert.equal(blocked.status, 403);
    assert.equal((await call("/api/shutdown", "POST")).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(local.server.listening, false);
  } finally { if (local.server.listening) await new Promise((resolve) => local.server.close(resolve)); }
});
