import { readSessionMessages } from "./discovery.mjs";
import { redactText } from "./privacy.mjs";
import { userMessageExcerpt } from "./session-labels.mjs";

function inventory(detections) {
  const kinds = new Map();
  for (const detection of detections) {
    const item = kinds.get(detection.kind) || { kind: detection.kind, label: detection.label, replacement: detection.replacement, count: 0, enabledCount: 0, matches: new Map() };
    item.count++;
    if (detection.enabled) item.enabledCount++;
    const existing = item.matches.get(detection.value) || {
      id: detection.matchId,
      value: detection.value.length > 300 ? `${detection.value.slice(0, 300)}…` : detection.value,
      count: 0,
      enabled: detection.enabled,
      contexts: [],
    };
    existing.count++;
    if (existing.contexts.length < 4) existing.contexts.push({
      before: detection.context.before.replace(/\s+/g, " "),
      match: detection.context.match.length > 120 ? `${detection.context.match.slice(0, 120)}…` : detection.context.match,
      after: detection.context.after.replace(/\s+/g, " "),
    });
    item.matches.set(detection.value, existing);
    kinds.set(detection.kind, item);
  }
  return [...kinds.values()].map((item) => ({
    ...item,
    enabled: item.enabledCount === item.count,
    matches: [...item.matches.values()].sort((left, right) => right.count - left.count),
  })).sort((left, right) => right.count - left.count);
}

function sessionSummary(messages) {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const excerpt = userMessageExcerpt(message.text);
    if (excerpt) return excerpt;
  }
  return "No user message available";
}

export async function makeDonationPreview(catalog, sessionIds, { disabledKinds = [], disabledMatches = [], unredacted = false } = {}) {
  const ids = [...new Set(sessionIds)].slice(0, 250);
  const detections = [];
  const sessions = [];
  for (const id of ids) {
    const session = catalog.index.get(id);
    if (!session) continue;
    const sourceMessages = await readSessionMessages(session);
    const messages = sourceMessages.map((message) => {
      const result = unredacted ? { text: message.text, detections: [] } : redactText(message.text, { disabledKinds, disabledMatches });
      detections.push(...result.detections);
      return { role: message.role, text: result.text, ...(message.timestamp ? { timestamp: message.timestamp } : {}) };
    }).filter((message) => message.text);
    if (messages.length) sessions.push({ sessionId: id, source: session.agent, label: `${session.agentName} · ${new Date(session.startedAt).toLocaleDateString()}`, summary: sessionSummary(messages), messages });
  }
  const enabledDetections = detections.filter((detection) => detection.enabled).length;
  return {
    format: "susan-calvin-donation-preview-v1",
    createdLocally: true,
    unredacted,
    detectionCount: enabledDetections,
    redactions: inventory(detections),
    sessions,
  };
}
