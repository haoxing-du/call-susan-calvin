import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { discoverAllSessions, readSessionMessages } from "../server/discovery.mjs";

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-labels-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function jsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");
}
const timestamp = "2026-09-01T12:00:00.000Z";
const user = (content, extra = {}) => ({ type: "user", timestamp, message: { content }, ...extra });
function options(root) {
  return { claudeRoot: path.join(root, "claude"), coworkRoot: path.join(root, "cowork"), codexRoots: [path.join(root, "codex/sessions")], cache: false };
}

test("Claude titles prefer custom names and excerpts skip metadata and tool results", async (t) => {
  const root = workspace(t);
  jsonl(path.join(root, "claude/project/session.jsonl"), [
    user("Internal setup", { isMeta: true }),
    user([{ type: "tool_result", content: "Tool response" }]),
    user([{ type: "text", text: "Fix the login form.\nKeep keyboard navigation." }]),
    { type: "ai-title", aiTitle: "Login form", sessionId: "session" },
    { type: "custom-title", customTitle: "My login fix", sessionId: "session" },
    { type: "ai-title", aiTitle: "Later generated name", sessionId: "session" },
    { type: "custom-title", customTitle: "Unrelated session", sessionId: "other" },
  ]);
  const catalog = await discoverAllSessions(options(root));
  const [session] = catalog.sessions;
  assert.equal(session.title, "My login fix");
  assert.equal(session.firstUserMessage, "Fix the login form. Keep keyboard navigation.");
  assert.equal("file" in session, false);
  assert.equal("sourceSessionId" in session, false);
  const messages = await readSessionMessages(catalog.index.get(session.id));
  assert.equal(messages[0].text, "Fix the login form.\nKeep keyboard navigation.");
});

test("Codex joins saved titles by session ID, keeps latest name, and skips setup-only prompts", async (t) => {
  const root = workspace(t);
  const setup = "# AGENTS.md instructions\n<INSTRUCTIONS>Repo instructions</INSTRUCTIONS><environment_context>Local setup</environment_context>";
  jsonl(path.join(root, "codex/sessions/rollout.jsonl"), [
    { type: "session_meta", timestamp, payload: { id: "codex-id" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: setup }] } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>Plugin list</recommended_plugins>Build a session picker." }] } },
  ]);
  jsonl(path.join(root, "codex/session_index.jsonl"), [
    { id: "unrelated", thread_name: "Wrong task", updated_at: "2026-09-03" },
    { id: "codex-id", thread_name: "Session picker", updated_at: "2026-09-02" },
    "malformed JSON",
    { id: "codex-id", thread_name: "Old title", updated_at: "2026-09-01" },
  ]);
  const catalog = await discoverAllSessions(options(root));
  assert.equal(catalog.sessions[0].title, "Session picker");
  assert.equal(catalog.sessions[0].firstUserMessage, "Build a session picker.");
  const messages = await readSessionMessages(catalog.index.get(catalog.sessions[0].id));
  assert.equal(messages[0].text, setup, "display cleanup must not edit transcript content");
});

test("Claude Cowork reads sibling titles and safely falls back when metadata is missing or malformed", async (t) => {
  const root = workspace(t);
  const sessionRoot = path.join(root, "cowork/account/workspace/local_example");
  jsonl(path.join(sessionRoot, "audit.jsonl"), [
    user("Ignore replay", { isReplay: true, uuid: "replay" }),
    user("First request. " + "More details. ".repeat(40), { uuid: "user" }),
    user("Duplicate", { uuid: "user" }),
  ]);
  fs.writeFileSync(`${sessionRoot}.json`, JSON.stringify({ title: "Research update", emailAddress: "must-not-copy@example.com" }));
  let catalog = await discoverAllSessions(options(root));
  assert.equal(catalog.sessions[0].agentName, "Claude Cowork");
  assert.equal(catalog.sessions[0].title, "Research update");
  assert.ok(catalog.sessions[0].firstUserMessage.length <= 240);
  assert.ok(catalog.sessions[0].firstUserMessage.endsWith("…"));
  assert.equal(JSON.stringify(catalog.sessions).includes("must-not-copy"), false);
  fs.writeFileSync(`${sessionRoot}.json`, "not JSON");
  catalog = await discoverAllSessions(options(root));
  assert.equal(catalog.sessions[0].title, "");
  assert.ok(catalog.sessions[0].firstUserMessage.startsWith("First request."));
  fs.unlinkSync(`${sessionRoot}.json`);
  assert.equal((await discoverAllSessions(options(root))).sessions.length, 1);
});

test("cache upgrades retain excerpts and refresh external titles without transcript changes", (t) => {
  const root = workspace(t);
  const store = path.join(root, ".call-susan-calvin");
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, "session-index-v1.json"), JSON.stringify({ version: 1, entries: {} }));
  jsonl(path.join(root, ".codex/sessions/test.jsonl"), [
    { type: "session_meta", timestamp, payload: { id: "cached-id" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: "Please inspect the changes." } },
  ]);
  const index = path.join(root, ".codex/session_index.jsonl");
  jsonl(index, [{ id: "cached-id", thread_name: "Original title" }]);
  const moduleUrl = new URL("../server/discovery.mjs", import.meta.url).href;
  const scan = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `import { discoverAllSessions } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify((await discoverAllSessions()).sessions));`], {
    env: { ...process.env, HOME: root, CALL_SUSAN_CALVIN_STORE_ROOT: store }, encoding: "utf8",
  }));
  assert.equal(scan()[0].title, "Original title");
  jsonl(index, [{ id: "cached-id", thread_name: "Renamed title" }]);
  assert.equal(scan()[0].title, "Renamed title");
  assert.equal(scan()[0].firstUserMessage, "Please inspect the changes.");
  const cacheFile = path.join(store, "session-index-v1.json");
  assert.equal(JSON.parse(fs.readFileSync(cacheFile)).version, 2);
  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
});
