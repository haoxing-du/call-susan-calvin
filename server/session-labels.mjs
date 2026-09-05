// Display-only excerpts. The transcript itself is never changed here.
export function compactLabel(value, maximum = 240) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1).trimEnd()}…` : text;
}

export function userMessageExcerpt(value) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, " ")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gi, " ")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, " ")
    .replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, " ")
    .replace(/# AGENTS\.md instructions[^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, " ");
  return compactLabel(text);
}
