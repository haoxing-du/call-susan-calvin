export const DONATION_FORMAT = "susan-calvin-donation-v1";
export const DONATION_CONSENT_VERSION = 1;
export const MAX_DONATION_BYTES = 20_000_000;
const MAX_SESSIONS = 250;
const MAX_MESSAGES = 50_000;
const MAX_MESSAGE_LENGTH = 7_000_000;
const sources = new Set(["claude", "cowork", "codex"]);
const modes = new Set(["standard", "custom", "unredacted"]);

function cleanText(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : "";
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
}

export function normalizeDonation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.consent?.researchDonation !== true || !modes.has(value.redactionMode)) return null;
  if (!/^[0-9a-f-]{36}$/.test(value.donationRunId || "")) return null;
  if (value.redactionMode === "unredacted" && value.consent?.unredactedData !== true) return null;
  if (!Array.isArray(value.sessions) || !value.sessions.length || value.sessions.length > MAX_SESSIONS) return null;
  if (value.group && (!/^[0-9a-f-]{36}$/.test(value.group.id || "") || !Number.isInteger(value.group.index) || !Number.isInteger(value.group.count) || value.group.count < 1 || value.group.count > 100_000 || value.group.index < 0 || value.group.index >= value.group.count)) return null;
  const sessions = [];
  let messageCount = 0;
  for (const session of value.sessions) {
    if (!session || !sources.has(session.source) || !Array.isArray(session.messages)) return null;
    const messages = [];
    for (const message of session.messages) {
      if (!message || !["user", "assistant"].includes(message.role)) return null;
      const text = cleanText(message.text).trim();
      // Reject blank edits instead of silently removing a transcript turn.
      if (!text) return null;
      if (text.length > MAX_MESSAGE_LENGTH) return null;
      const at = timestamp(message.timestamp);
      messages.push({ role: message.role, text, ...(at ? { timestamp: at } : {}) });
      messageCount++;
      if (messageCount > MAX_MESSAGES) return null;
    }
    if (messages.length) sessions.push({ source: session.source, messages });
  }
  if (!sessions.length) return null;
  const sourceTypes = [...new Set(sessions.map((session) => session.source))].sort();
  const unredacted = value.redactionMode === "unredacted";
  return {
    format: DONATION_FORMAT,
    donationRunId: value.donationRunId,
    ...(value.group ? { group: { id: value.group.id, index: value.group.index, count: value.group.count } } : {}),
    collector: { name: "share-with-susan-calvin", version: cleanText(value.collector?.version).slice(0, 32) || "unknown" },
    sourceTypes,
    redactionMode: value.redactionMode,
    createdAt: timestamp(value.createdAt) || new Date().toISOString(),
    redactionSummary: {
      automatedDetections: unredacted ? 0 : Math.round(Math.max(0, Math.min(Number(value.redactionSummary?.automatedDetections) || 0, 1_000_000))),
      sessions: sessions.length,
      messages: messageCount,
    },
    sessions,
    consent: {
      researchDonation: true,
      ...(unredacted ? { unredactedData: true } : {}),
      consentVersion: DONATION_CONSENT_VERSION,
      statement: unredacted
        ? "I understand that this donation is not automatically redacted and may contain credentials, personal details, private code, URLs, and file paths. I consent to transmit this reviewed data to the Susan Calvin Project for research under the data policy."
        : "I consent for this reviewed data to be transmitted to the Susan Calvin Project and used for research under the data policy.",
      consentedAt: timestamp(value.consent.consentedAt) || new Date().toISOString(),
    },
  };
}

export function donationByteLength(value) {
  const donation = normalizeDonation(value);
  return donation ? new TextEncoder().encode(JSON.stringify(donation)).byteLength : null;
}

export function sanitizeDonation(value) {
  const donation = normalizeDonation(value);
  return donation && new TextEncoder().encode(JSON.stringify(donation)).byteLength <= MAX_DONATION_BYTES ? donation : null;
}
