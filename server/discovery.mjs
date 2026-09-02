import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { canonicalSessionRoots } from "./platform.mjs";
import { storeRoot } from "./store.mjs";

export const DEFAULT_WINDOW_DAYS = 30;
const cacheFile = path.join(storeRoot, "session-index-v1.json");

function opaqueId(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function agentName(agent) {
  if (agent === "codex") return "Codex";
  if (agent === "cowork") return "Cowork";
  return "Claude Code";
}

function isoTimestamp(value, fallback = null) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function recursiveJsonl(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const item = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(item);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(item);
    }
  }
  return files;
}

function claudeSessionFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return files; }
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, project.name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(root, project.name, entry.name));
  }
  return files;
}

async function visitJsonLines(file, visit) {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line)); } catch { /* Malformed records are ignored. */ }
  }
}

function readCache() {
  try {
    const value = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return value?.version === 1 && value.entries && typeof value.entries === "object" ? value.entries : {};
  } catch { return {}; }
}

function writeCache(entries) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, cacheFile);
}

function coworkTimestamp(record) {
  return record?.timestamp || record?._audit_timestamp || null;
}

async function sessionMetadata(file, agent, cache) {
  const stat = await fs.promises.stat(file);
  const key = `${agent}:${file}:${stat.size}:${stat.mtimeMs}`;
  if (cache[key]) return { ...cache[key], file };
  let firstTimestamp = null;
  let lastTimestamp = null;
  let promptCount = 0;
  let messageCount = 0;
  const seenCoworkUuids = new Set();
  await visitJsonLines(file, (record) => {
    if (agent === "codex") {
      const payload = record?.payload;
      if (record?.type === "response_item" && payload?.type === "message" && ["user", "assistant"].includes(payload.role)) {
        messageCount++;
        if (payload.role === "user") promptCount++;
      }
    } else {
      if (agent === "cowork") {
        if (record?.isReplay === true || (record?.uuid && seenCoworkUuids.has(record.uuid))) return;
        if (record?.uuid) seenCoworkUuids.add(record.uuid);
      }
      if (["user", "assistant"].includes(record?.type) && !record?.isMeta) {
        messageCount++;
        if (record.type === "user") promptCount++;
      }
    }
    const timestamp = agent === "cowork" ? coworkTimestamp(record) : record?.timestamp;
    const normalized = isoTimestamp(timestamp);
    if (normalized) { firstTimestamp ||= normalized; lastTimestamp = normalized; }
  });
  const metadata = {
    id: opaqueId(file),
    agent,
    agentName: agentName(agent),
    startedAt: firstTimestamp || stat.birthtime.toISOString(),
    endedAt: lastTimestamp || stat.mtime.toISOString(),
    promptCount,
    messageCount,
    sizeBytes: stat.size,
  };
  for (const existing of Object.keys(cache)) if (cache[existing]?.id === metadata.id && existing !== key) delete cache[existing];
  cache[key] = metadata;
  return { ...metadata, file };
}

function candidateFiles({ claudeRoot, coworkRoot, codexRoots }) {
  return [
    ...claudeSessionFiles(claudeRoot).map((file) => ({ file, agent: "claude" })),
    ...recursiveJsonl(coworkRoot).filter((file) => path.basename(file) === "audit.jsonl" && path.basename(path.dirname(file)).startsWith("local_")).map((file) => ({ file, agent: "cowork" })),
    ...codexRoots.flatMap((root) => recursiveJsonl(root).map((file) => ({ file, agent: "codex" }))),
  ];
}

export async function discoverAllSessions(options = {}) {
  const roots = { ...canonicalSessionRoots(), ...options };
  const persistCache = options.cache !== false && !options.claudeRoot && !options.coworkRoot && !options.codexRoots;
  const cache = persistCache ? readCache() : {};
  const sessions = [];
  for (const candidate of candidateFiles(roots)) {
    try {
      const metadata = await sessionMetadata(candidate.file, candidate.agent, cache);
      if (metadata.messageCount) sessions.push(metadata);
    } catch { /* Unreadable session files are skipped. */ }
  }
  if (persistCache) writeCache(cache);
  sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    sessions: sessions.map(({ file, ...session }) => session),
    index: new Map(sessions.map((session) => [session.id, session])),
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && ["text", "input_text", "output_text"].includes(block.type) && typeof block.text === "string").map((block) => block.text).join("\n");
}

export async function readSessionMessages(session) {
  const messages = [];
  const seen = new Set();
  const seenCoworkUuids = new Set();
  const coworkAssistantMessages = new Map();
  await visitJsonLines(session.file, (record) => {
    let role;
    let text;
    let timestamp;
    if (session.agent === "codex") {
      const payload = record?.payload;
      if (record?.type !== "response_item" || payload?.type !== "message" || !["user", "assistant"].includes(payload.role)) return;
      role = payload.role;
      text = textFromContent(payload.content);
      timestamp = record.timestamp;
    } else {
      if (session.agent === "cowork") {
        if (record?.isReplay === true || (record?.uuid && seenCoworkUuids.has(record.uuid))) return;
        if (record?.uuid) seenCoworkUuids.add(record.uuid);
      }
      if (!["user", "assistant"].includes(record?.type) || record?.isMeta) return;
      role = record.type;
      text = textFromContent(record?.message?.content ?? record?.content);
      timestamp = session.agent === "cowork" ? coworkTimestamp(record) : record.timestamp;
    }
    text = String(text || "").trim();
    if (!text) return;
    const coworkMessageId = session.agent === "cowork" && role === "assistant" && typeof record?.message?.id === "string" ? record.message.id : null;
    if (coworkMessageId && coworkAssistantMessages.has(coworkMessageId)) {
      const previous = coworkAssistantMessages.get(coworkMessageId);
      if (!previous.text.includes(text)) previous.text = `${previous.text}\n${text}`;
      return;
    }
    const key = `${role}\0${timestamp || ""}\0${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const message = { role, text, timestamp: isoTimestamp(timestamp) };
    messages.push(message);
    if (coworkMessageId) coworkAssistantMessages.set(coworkMessageId, message);
  });
  return messages;
}

export function sessionsInWindow(sessions, { days = DEFAULT_WINDOW_DAYS, sources = [] } = {}) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const sourceSet = new Set(sources);
  return sessions.filter((session) => {
    const started = new Date(session.startedAt);
    return started >= start && started <= end && (!sourceSet.size || sourceSet.has(session.agent));
  });
}
