const SECRET_PATTERNS = [
  ["api-secret", "API keys and secrets", /\bsk[-_][a-z0-9_-]{16,}\b/gi, "[REDACTED SECRET]"],
  ["aws-key", "AWS access keys", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  ["github-token", "GitHub tokens", /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
  ["private-key", "Private keys", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
];

const PII_PATTERNS = [
  ["phone", "Phone numbers", /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[REDACTED PHONE]"],
  ["ssn", "Social Security numbers", /\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED SSN]"],
  ["payment-number", "Possible payment-card numbers", /\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED NUMBER]"],
];

const LABELED_CREDENTIAL = /\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\s*[:=]\s*(?:"[^"\n]{4,256}"|'[^'\n]{4,256}'|`[^`\n]{4,256}`|[^\s,;]{8,256})/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HOME_USER = /(\/Users\/|\/home\/)([^/\s]+)/g;

function matchId(kind, value) {
  const input = `${kind}\0${value}`;
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b].map((seed) => {
    let hash = seed;
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
      hash ^= hash >>> 13;
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }).join("");
}

function detail(kind, label, value, replacement, offset, source, enabled) {
  return {
    kind,
    label,
    matchId: matchId(kind, value),
    value,
    replacement,
    enabled,
    length: value.length,
    context: {
      before: source.slice(Math.max(0, offset - 80), offset),
      match: value,
      after: source.slice(offset + value.length, offset + value.length + 80),
    },
  };
}

function likelyCredential(match) {
  const raw = match.replace(/^[^:=]+[:=]\s*/, "").replace(/^["'`]|["'`]$/g, "");
  if (/^(?:removed|omitted|redacted|none|null|undefined)$/i.test(raw)) return false;
  return raw.length >= 12 || (raw.length >= 8 && /[A-Za-z]/.test(raw) && /\d/.test(raw));
}

function sshIdentity(match, offset, source) {
  return match.toLowerCase().startsWith("git@") || source.slice(Math.max(0, offset - 8), offset).endsWith("ssh://") || source[offset + match.length] === ":";
}

export function redactText(input, { disabledKinds = [], disabledMatches = [] } = {}) {
  let text = String(input ?? "");
  const detections = [];
  const disabledKindSet = new Set(disabledKinds);
  const disabledMatchSet = new Set(disabledMatches);
  const replacements = [];
  const replace = (kind, label, replacement) => (value, offset, source) => {
    const id = matchId(kind, value);
    const enabled = !disabledKindSet.has(kind) && !disabledMatchSet.has(id);
    detections.push(detail(kind, label, value, replacement, offset, source, enabled));
    if (enabled) return replacement;
    const marker = `\uE000${replacements.length}\uE001`;
    replacements.push([marker, value]);
    return marker;
  };

  text = text.replace(LABELED_CREDENTIAL, (value, offset, source) => likelyCredential(value)
    ? replace("credential", "Labeled credentials", "[REDACTED CREDENTIAL]")(value, offset, source)
    : value);
  for (const [kind, label, pattern, replacement] of [...SECRET_PATTERNS, ...PII_PATTERNS]) text = text.replace(pattern, replace(kind, label, replacement));
  text = text.replace(EMAIL, (value, offset, source) => sshIdentity(value, offset, source) ? value : replace("email", "Email addresses", "[REDACTED EMAIL]")(value, offset, source));
  text = text.replace(HOME_USER, (value, prefix, _user, offset, source) => replace("home-user", "Home-directory usernames", `${prefix}[REDACTED USER]`)(value, offset, source));
  for (const [marker, value] of replacements) text = text.replaceAll(marker, value);
  return { text, detections };
}

