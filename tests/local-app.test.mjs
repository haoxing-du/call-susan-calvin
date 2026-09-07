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

test("local donations reject freely rewritten transcripts", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  try {
    const response = await fetch(`${local.url}/api/donations`, { method: "POST", headers: { origin: local.url, "content-type": "application/json" }, body: JSON.stringify({ donation: { sessions: [{ messages: [{ role: "user", text: "Invented transcript" }] }] } }) });
    assert.equal(response.status, 410);
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
    const emails = await (await call(`/api/reviews/${job.id}/redactions/email`)).json();
    assert.equal(emails.count, 1);
    assert.deepEqual(emails.matches.map(m => [m.value, m.count, m.enabled]), [["researcher@example.com", 1, true]]);
    const location = await (await call(`/api/reviews/${job.id}/redactions/email/${emails.matches[0].id}?position=0`)).json();
    assert.equal(location.total, 1);
    assert.equal(location.messageIndex, 0);
    assert.match(location.before, /Contact me at /);
    assert.equal(location.sessionId, catalog.sessions.find(s => s.title === "Demo build failure").id);
    const phones = await (await call(`/api/reviews/${job.id}/redactions/phone`)).json();
    assert.deepEqual(phones.matches, []);
    const preview = await (await call(`/api/reviews/${job.id}/sessions/0`)).json();
    assert.equal(preview.sessions.length, 1);
    assert.equal((await call(`/api/reviews/${job.id}/sessions/0`, "PUT", { messages: [{ role: "user", text: "Invented transcript" }] })).status, 405);
    assert.match((await (await call(`/api/reviews/${job.id}/sessions/0`, "POST", { type: "text", pattern: "research" })).json()).error, /read-only/);
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


test("custom mode starts from standard redactions; standard rules cannot be disabled", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  const call = async (route, method = "GET", body) => (await fetch(`${local.url}${route}`, { method, headers: { origin: local.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  try {
    const catalog = await call("/api/catalog");
    const sessionIds = catalog.sessions.map(s => s.id);
    async function prepare(mode, extras = {}) {
      const job = await call("/api/reviews", "POST", { sessionIds, mode, ...extras });
      let status;
      do { status = await call(`/api/reviews/${job.id}`); } while (status.status === "preparing");
      assert.equal(status.status, "ready");
      return Promise.all(sessionIds.map((_, i) => call(`/api/reviews/${job.id}/sessions/${i}`)));
    }
    const standard = await prepare("standard");
    const custom = await prepare("custom");
    assert.deepEqual(custom, standard);
    const disabledKinds = [...new Set(standard.flatMap(p => p.redactions.map(r => r.kind)))];
    assert.ok(disabledKinds.length);
    const disabledMatches = standard.flatMap(p => p.redactions.flatMap(r => r.matches.map(m => m.id)));
    assert.deepEqual(await prepare("standard", { disabledKinds, disabledMatches, unredacted: true }), standard);
    assert.ok((await prepare("custom", { disabledKinds })).every(p => p.detectionCount === 0));
  } finally { await new Promise((resolve) => local.server.close(resolve)); }
});


test("an obsolete local preview can be cancelled and replaced without transmitting", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  const call = async (route, method = "GET", body) => fetch(`${local.url}${route}`, { method, headers: { origin: local.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const catalog = await (await call("/api/catalog")).json();
    const body = { sessionIds: catalog.sessions.map(s => s.id), mode: "standard" };
    const initial = await (await call("/api/reviews", "POST", body)).json();
    assert.equal((await call(`/api/reviews/${initial.id}`, "DELETE")).status, 200);
    const latest = await (await call("/api/reviews", "POST", { ...body, sessionIds: [body.sessionIds[2]], mode: "unredacted" })).json();
    let status;
    do { status = await (await call(`/api/reviews/${latest.id}`)).json(); } while (status.status === "preparing");
    assert.equal(status.status, "ready");
    assert.deepEqual(status.sessions.map(s => s.id), [body.sessionIds[2]]);
    const preview = await (await call(`/api/reviews/${latest.id}/sessions/0`)).json();
    assert.equal(preview.detectionCount, 0);
    assert.equal((await call(`/api/reviews/${latest.id}/donate`, "POST", {})).status, 400);
  } finally { await new Promise(resolve => local.server.close(resolve)); }
});

test("custom redactions survive selection, mode and rule changes until a donation-wide reset", async () => {
  const local = await startLocalApp({ port: 0, demo: true });
  const call = async (route, method = "GET", body) => {
    const response = await fetch(`${local.url}${route}`, { method, headers: { origin: local.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  async function prepare(sessionIds, mode = "custom", extras = {}) {
    let job = await call("/api/reviews", "POST", { sessionIds, mode, ...extras });
    while (job.status === "preparing") job = await call(`/api/reviews/${job.id}`);
    assert.equal(job.status, "ready", job.error);
    return job;
  }
  async function change(job, rule) {
    let result = await call(`/api/reviews/${job.id}/custom`, rule ? "POST" : "DELETE", rule);
    while (result.redacting) result = await call(`/api/reviews/${job.id}`);
    assert.equal(result.customError, "");
    return result;
  }
  try {
    const catalog = await call("/api/catalog");
    const claude = catalog.sessions.find(s => s.agent === "claude").id;
    const cowork = catalog.sessions.find(s => s.agent === "cowork").id;
    let job = await prepare([claude, cowork]);
    const applied = await change(job, { pattern: "configuration mismatch", type: "text" });
    const first = { preview: await call(`/api/reviews/${job.id}/sessions/0`) };
    await change(job, { pattern: "research", type: "text" });
    const second = { preview: await call(`/api/reviews/${job.id}/sessions/1`) };
    assert.equal(applied.customCount, 1);
    assert.match(second.preview.sessions[0].summary, /\[REDACTED\]/);
    job = await prepare([claude]);
    assert.deepEqual((await call(`/api/reviews/${job.id}/sessions/0`)).sessions, first.preview.sessions);
    const excluded = await call("/api/donation-preview", "POST", { sessionIds: [cowork], mode: "custom" });
    assert.deepEqual(excluded.sessions, second.preview.sessions, "excluded sessions retain their saved redactions");
    for (const mode of ["standard", "unredacted"]) {
      job = await prepare([claude], mode);
      const plain = await call(`/api/reviews/${job.id}/sessions/0`);
      assert.match(plain.sessions[0].messages[1].text, /configuration mismatch/);
      assert.equal(plain.customRedactionCount, 2, "other modes suspend custom patterns without deleting them");
    }
    job = await prepare([cowork, claude]);
    assert.deepEqual((await call(`/api/reviews/${job.id}/sessions/1`)).sessions, first.preview.sessions, "reordering preserves global rules");
    job = await prepare([claude, cowork], "custom", { disabledKinds: first.preview.redactions.map(r => r.kind) });
    let current = await call(`/api/reviews/${job.id}/sessions/0`);
    assert.equal(current.detectionCount, 0);
    assert.match(current.sessions[0].messages[1].text, /\[REDACTED\]/);
    const customRules = (await call(`/api/reviews/${job.id}`)).customRules;
    assert.equal(customRules.length, 2);
    const removeRoute = `/api/reviews/${job.id}/custom/${customRules[0].id}`;
    assert.equal((await fetch(`${local.url}${removeRoute}`, { method: "DELETE", headers: { origin: "https://attacker.example" } })).status, 403);
    let removing = await call(removeRoute, "DELETE");
    while (removing.redacting) removing = await call(`/api/reviews/${job.id}`);
    assert.equal(removing.customError, "");
    assert.deepEqual(removing.customRules.map(rule => rule.pattern), ["research"]);
    assert.match((await call(`/api/reviews/${job.id}/sessions/0`)).sessions[0].messages[1].text, /configuration mismatch/);
    assert.match((await call(`/api/reviews/${job.id}/sessions/1`)).sessions[0].summary, /\[REDACTED\]/);
    const crossOrigin = await fetch(`${local.url}/api/reviews/${job.id}/custom`, { method: "DELETE", headers: { origin: "https://attacker.example" } });
    assert.equal(crossOrigin.status, 403);
    await change(job);
    const reset = { preview: await call(`/api/reviews/${job.id}/sessions/0`) };
    assert.match(reset.preview.sessions[0].messages[1].text, /configuration mismatch/);
    assert.equal(reset.preview.detectionCount, 0, "reset does not change automatic rules");
    assert.equal(reset.preview.customRedactionCount, 0);
    assert.doesNotMatch(JSON.stringify((await call(`/api/reviews/${job.id}/sessions/1`)).sessions), /REDACTED/);
    job = await prepare([claude, cowork]);
    current = await call(`/api/reviews/${job.id}/sessions/0`);
    assert.match(current.sessions[0].messages[1].text, /configuration mismatch/, "reset survives the next rebuild");
    assert.doesNotMatch(JSON.stringify((await call(`/api/reviews/${job.id}/sessions/1`)).sessions), /REDACTED/);
  } finally { await new Promise(resolve => local.server.close(resolve)); }
});
