import crypto from "node:crypto";
import { redactText } from "./privacy.mjs";
import { createRedactor } from "./custom-redaction.mjs";

import { sanitizeClassifierFeedback } from "./classifier-feedback-schema.mjs";

export async function prepareFeedback(context, input, options, customRules) {
  const value = sanitizeClassifierFeedback({ ...context, correctedLabel: input.correctedLabel, note: input.note });
  if (!value) throw new Error("Choose a valid correction and a note of at most 1,000 characters.");
  const redactor = createRedactor();
  try {
    // Extra text is reviewed separately, and follows the same redaction preferences.
    for (const field of ["judgedText", "note"]) {
      if (!value[field]) continue;
      let content = options.unredacted ? value[field] : redactText(value[field], options).text;
      if (options.mode === "custom") for (const rule of customRules) {
        content = (await redactor.redact([{ role: "user", text: content }], rule.pattern, rule.type)).messages[0].text;
      }
      value[field] = content;
    }
    // Redaction markers can expand short strings; the payload must still meet bounds.
    if (!sanitizeClassifierFeedback(value)) throw new Error("The redacted correction exceeds the supported length. Shorten the note or omit it.");
    return { revision: crypto.randomUUID(), value };
  } finally { await redactor.close(); }
}
