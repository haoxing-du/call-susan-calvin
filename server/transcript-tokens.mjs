import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";

export const TOKEN_ENCODING = "cl100k_base";
// Count normalized, shared message text; exclude metadata and chat framing.
export function countTranscriptTokens(donation) {
  let total = 0;
  for (const session of donation.sessions) {
    for (const message of session.messages) total += countTokens(message.text, { disallowedSpecial: new Set() });
  }
  return total;
}
