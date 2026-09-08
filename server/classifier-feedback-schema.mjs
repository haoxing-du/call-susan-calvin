export const FEEDBACK_CONSENT_VERSION = 2;
export const FEEDBACK_CONSENT = "I consent to share this reviewed session and classification correction with the Susan Calvin Project for research and to evaluate and improve Behavior Wrapped under the data policy.";
const labels = new Set(["yelling", "thanking", "neither", "unsure"]);
const text = (value, max) => typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

export function sanitizeFeedbackContext(value) {
  if (!value || !["yelling", "thanking"].includes(value.originalLabel)
    || !text(value.candidateId, 64) || !value.candidateId
    || !text(value.judgedText, 240)
    || !Number.isInteger(value.occurrences) || value.occurrences < 1 || value.occurrences > 1_000_000
    || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || !text(value.judge?.model, 120) || !value.judge.model
    || !Number.isInteger(value.judge?.promptVersion) || value.judge.promptVersion < 1) return null;
  return { originalLabel: value.originalLabel, candidateId: value.candidateId, judgedText: value.judgedText,
    occurrences: value.occurrences, confidence: value.confidence,
    judge: { model: value.judge.model, promptVersion: value.judge.promptVersion } };
}

export function sanitizeClassifierFeedback(value) {
  const context = sanitizeFeedbackContext(value);
  if (!context || !labels.has(value.correctedLabel) || (value.note !== undefined && !text(value.note, 1_000))) return null;
  return { ...context, correctedLabel: value.correctedLabel, ...(value.note ? { note: value.note } : {}) };
}

