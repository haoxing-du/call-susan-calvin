import { parsePhoneNumberFromString } from "libphonenumber-js/max";

const SECRET_PATTERNS = [
  ["api-secret", "API keys and secrets", /\bsk[-_][a-z0-9_-]{16,}\b/gi, "[REDACTED SECRET]"],
  ["aws-key", "AWS access keys", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  ["github-token", "GitHub tokens", /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]"],
  ["private-key", "Private keys", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
];

const PII_PATTERNS = [
  ["phone", "Phone numbers", /(?<![\p{L}\p{N}_+])(?:\+?1[.\t -]?)?(?:\(\d{3}\)|\d{3})[.\t -]?\d{3}[.\t -]?\d{4}(?![\p{L}\p{N}_])/gu, "[REDACTED PHONE]"],
  ["ssn", "Social Security numbers", /(?<![\p{L}\p{N}_])\d{3}-\d{2}-\d{4}(?![\p{L}\p{N}_])/gu, "[REDACTED SSN]"],
  ["payment-number", "Possible payment-card numbers", /(?<![\p{L}\p{N}_])\d(?:[\t -]*\d){12,18}(?![\p{L}\p{N}_])/gu, "[REDACTED NUMBER]"],
];

const LABELED_CREDENTIAL = /\b(?:password|passwd|pwd|secret|token|api[_ -]?key)\s*[:=]\s*(?:"[^"\n]{4,256}"|'[^'\n]{4,256}'|`[^`\n]{4,256}`|[^\s,;]{8,256})/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const HOME_USER = /(\/Users\/|\/home\/)(\[REDACTED(?:[ _]USER)?\](?=\/|\s|$)|[^/\s]+)/g;
const EMAIL_PLACEHOLDERS = new Set(["name@example.com", "user@example.com", "username@example.com", "email@example.com", "yourname@example.com"]);
const HOME_PLACEHOLDER = /^(?:\[REDACTED(?:[ _]USER)?\]|<(?:user|username)>)$/i;

function technicalNumber(offset, source) {
  const before = source.slice(Math.max(0, offset - 256), offset);
  // Only explicit technical labels / article paths qualify. Never exempt an
  // entire URL: query parameters can contain real cards, phones, or credentials.
  return /\b(?:build|run|record|article|message|project)(?:[_ -]?(?:id|number))?["'`]?\s*[:=]?\s*["'`]?\s*$/i.test(before)
    || /\btimestamp["'`]?\s*[:=]?\s*["'`]?\s*$/i.test(before)
    || /https?:\/\/[^\s"'`<>?#]*\/(?:articles?|records?|issues?|pull|runs?|builds?)\/[^\s"'`<>/?#]*$/i.test(before);
}

function validNumericMatch(kind, value, offset, source) {
  if (technicalNumber(offset, source)) return false;
  if (kind === "phone") {
    // Do not reinterpret the national portion of an explicitly foreign number.
    if (!value.startsWith("+") && /\+\d{1,3}[\t -]+$/.test(source.slice(Math.max(0, offset - 8), offset))) return false;
    const phone = parsePhoneNumberFromString(value, { defaultCountry: "US", extract: false });
    return phone?.countryCallingCode === "1" && phone.isValid();
  }
  if (kind === "ssn") return !/^(?:000|666|9\d{2})-/.test(value) && !/-00-/.test(value) && !/-0000$/.test(value);
  // A card candidate must be complete, not a prefix of a longer digit sequence.
  if (/^[\t -]*\d/.test(source.slice(offset + value.length)) || /\d[\t -]*$/.test(source.slice(Math.max(0, offset - 8), offset))) return false;
  const digits = value.replace(/\D/g, "");
  if (/^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let digit = Number(digits[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

export const REDACTION_KINDS = [
  ["credential", "Labeled credentials"],
  ...SECRET_PATTERNS.map(([kind, label]) => [kind, label]),
  ...PII_PATTERNS.map(([kind, label]) => [kind, label]),
  ["email", "Email addresses"],
  ["home-user", "Home-directory usernames"],
].map(([kind, label]) => ({ kind, label }));

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
  for (const [kind, label, pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replace(kind, label, replacement));
  for (const [kind, label, pattern, replacement] of PII_PATTERNS) text = text.replace(pattern, (value, offset, source) => validNumericMatch(kind, value, offset, source) ? replace(kind, label, replacement)(value, offset, source) : value);
  text = text.replace(EMAIL, (value, offset, source) => sshIdentity(value, offset, source) || EMAIL_PLACEHOLDERS.has(value.toLowerCase()) ? value : replace("email", "Email addresses", "[REDACTED EMAIL]")(value, offset, source));
  text = text.replace(HOME_USER, (value, prefix, user, offset, source) => HOME_PLACEHOLDER.test(user) ? value : replace("home-user", "Home-directory usernames", `${prefix}[REDACTED USER]`)(value, offset, source));
  for (const [marker, value] of replacements) text = text.replaceAll(marker, value);
  return { text, detections };
}
