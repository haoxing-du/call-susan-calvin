// Recognize complete context blocks only at the beginning of a Codex user record.
// Preserve every character so the two editors reconstruct the original message.
const contextPrefix = /^(?:<(recommended_plugins|environment_context|skills_instructions|collaboration_mode)>[\s\S]*?<\/\1>|<permissions instructions>[\s\S]*?<\/permissions instructions>|# AGENTS\.md instructions[^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)/i;

export function splitCodexContext(value) {
  if (typeof value !== "string") return { context: "", text: "" };
  let offset = 0;
  while (offset < value.length) {
    const remaining = value.slice(offset);
    const whitespace = remaining.match(/^\s*/)[0].length;
    const match = remaining.slice(whitespace).match(contextPrefix);
    if (!match) break;
    offset += whitespace + match[0].length;
  }
  if (offset) offset += value.slice(offset).match(/^\s*/)[0].length;
  return { context: value.slice(0, offset), text: value.slice(offset) };
}
