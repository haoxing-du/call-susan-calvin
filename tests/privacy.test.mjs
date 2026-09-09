import test from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../server/privacy.mjs";

test("valid complete North American phones retain full spans and exact review context", () => {
  for (const number of ["415-555-0123", "+1 (415) 555-0123", "(415) 555-0123", "416.555.0123", "4155550123"]) {
    const result = redactText(`Call ${number} today.`);
    assert.equal(result.text, "Call [REDACTED PHONE] today.");
    assert.deepEqual(result.detections.map(d => [d.kind, d.value, d.context]), [["phone", number, { before: "Call ", match: number, after: " today." }]]);
  }
});

test("phone candidates must be valid numbers, not counts, IDs, line fragments, or foreign-number suffixes", () => {
  for (const input of ["Call 123-456-7890", "000-000-0000", "1234155550123456", "abc4155550123xyz", "build_id=4155550123", "1699 events", "ISO 27701/27018", "1680 Mission St", "415\n555\n0123", "+44 2079460958", "https://docs.example.org/articles/4155550123"]) {
    assert.equal(redactText(input).text, input, input);
  }
  assert.equal(redactText("https://example.org/contact?phone=4155550123").text, "https://example.org/contact?phone=[REDACTED PHONE]");
});

test("payment candidates require a checksum and complete boundaries", () => {
  for (const number of ["4111111111111111", "4242 4242 4242 4242", "3782-822463-10005", "4000000000000000006"]) {
    const result = redactText(`Card: ${number}.`);
    assert.equal(result.text, "Card: [REDACTED NUMBER].", number);
    assert.equal(result.detections[0].value, number);
  }
  for (const input of ["Card 4111111111111112", "0000000000000000", "1234567890123456", "x4111111111111111y", "41111111111111110000", "4242 4242\n4242 4242", "4111111111111111 1234", "build_id=4111111111111111", "timestamp: 4111111111111111", "https://docs.example.org/articles/4111111111111111"]) {
    assert.equal(redactText(input).text, input, input);
  }
  assert.equal(redactText("https://example.org/pay?card=4111111111111111").text, "https://example.org/pay?card=[REDACTED NUMBER]");
});

test("SSNs require plausible groups and remain detectable as complete formatted identifiers", () => {
  assert.equal(redactText("SSN: 123-45-6789").text, "SSN: [REDACTED SSN]");
  for (const number of ["000-45-6789", "666-45-6789", "900-45-6789", "123-00-6789", "123-45-0000", "x123-45-6789y", "123-45-67890"]) {
    assert.equal(redactText(number).text, number);
  }
});

test("only explicit email examples are exempt; ordinary contacts and lookalike domains stay covered", () => {
  for (const email of ["name@example.com", "NAME@EXAMPLE.COM", "user@example.com", "username@example.com", "email@example.com", "yourname@example.com"]) {
    const input = `Example: ${email}.`;
    assert.equal(redactText(input).text, input);
    assert.equal(redactText(input).detections.length, 0);
  }
  for (const email of ["person@example.com", "support@business.test", "name@example.com.evil.test", "name@another.test", "name+private@example.com"]) {
    assert.equal(redactText(`Contact ${email}`).text, "Contact [REDACTED EMAIL]");
  }
  assert.equal(redactText("git@github.com:org/repo.git").text, "git@github.com:org/repo.git");
});

test("home redaction is idempotent and preserves only explicitly marked placeholders", () => {
  for (const placeholder of ["[REDACTED USER]", "[REDACTED_USER]", "[REDACTED]", "<user>", "<username>"]) {
    const input = `/Users/${placeholder}/project /home/${placeholder}/project`;
    assert.equal(redactText(input).text, input);
    assert.deepEqual(redactText(input).detections, []);
  }
  const input = "Read /Users/alice/project and /home/username/project";
  const result = redactText(input);
  assert.equal(result.text, "Read /Users/[REDACTED USER]/project and /home/[REDACTED USER]/project");
  assert.equal(redactText(result.text).text, result.text);
  assert.deepEqual(redactText(result.text).detections, []);
  assert.equal(redactText("/Users/[REDACTED_USER]alice/project").text, "/Users/[REDACTED USER]/project");
});

test("validated findings still honor donor exclusions and leave credentials covered", () => {
  const input = "Card 4242424242424242; phone +1 (415) 555-0123; api_key=synthetic-secret-12345; name@example.com";
  const result = redactText(input);
  const card = result.detections.find(d => d.kind === "payment-number");
  assert.ok(card);
  const custom = redactText(input, { disabledKinds: ["phone"], disabledMatches: [card.matchId] });
  assert.match(custom.text, /4242424242424242/);
  assert.match(custom.text, /\+1 \(415\) 555-0123/);
  assert.doesNotMatch(custom.text, /synthetic-secret-12345/);
  assert.equal(custom.detections.find(d => d.kind === "payment-number").enabled, false);
});
