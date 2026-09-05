import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitCodexContext } from "../app/session-context.js";
import { discoverAllSessions, readSessionMessages } from "../server/discovery.mjs";
import { makeDonationPreview } from "../server/donation-preview.mjs";
import { sanitizeDonation } from "../server/donation-schema.mjs";

const plugins = "<recommended_plugins>\nAvailable plugins:\n- Example\n</recommended_plugins>";

test("Codex context is separated losslessly from an actual prompt", () => {
  const prefix = ` \n${plugins}\n\n# AGENTS.md instructions for /workspace\n<INSTRUCTIONS>Keep changes small.</INSTRUCTIONS>\n<environment_context>Local setup</environment_context>\n\n`;
  const prompt = "Review the changes.\nKeep the transcript intact.";
  const parts = splitCodexContext(prefix + prompt);
  assert.equal(parts.context, prefix);
  assert.equal(parts.text, prompt);
  assert.equal(parts.context + parts.text, prefix + prompt);
  parts.text = "Review [REDACTED].";
  assert.equal(parts.context + parts.text, prefix + "Review [REDACTED].");
});

test("context-only records remain complete and unknown or quoted content stays visible", () => {
  assert.deepEqual(splitCodexContext(plugins), { context: plugins, text: "" });
  for (const text of [
    "Please explain this:\n" + plugins,
    "```xml\n" + plugins + "\n```",
    "<recommended_plugins>Incomplete context without a closing tag",
    "<other_context>Do not guess unknown tags</other_context>",
    "A regular user prompt",
  ]) {
    assert.deepEqual(splitCodexContext(text), { context: "", text });
  }
});

test("folding context does not remove or relabel any donated transcript turn", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalog = await discoverAllSessions({
    claudeRoot: path.join(root, "fixtures/claude"),
    coworkRoot: path.join(root, "fixtures/cowork"),
    codexRoots: [path.join(root, "fixtures/codex")], cache: false,
  });
  const session = catalog.sessions.find((item) => item.agent === "codex");
  const original = await readSessionMessages(catalog.index.get(session.id));
  const preview = await makeDonationPreview(catalog, [session.id], { unredacted: true });
  assert.deepEqual(preview.sessions[0].messages, original);
  const contextOnly = splitCodexContext(original[0].text);
  assert.ok(contextOnly.context);
  assert.equal(contextOnly.text, "");
  const mixed = splitCodexContext(original[1].text);
  assert.ok(mixed.context);
  assert.equal(mixed.text, "Review the launch checklist and point out anything missing.");
  const donation = sanitizeDonation({
    donationRunId: "11111111-1111-4111-8111-111111111111", redactionMode: "unredacted",
    consent: { researchDonation: true, unredactedData: true },
    sessions: preview.sessions.map((item) => ({ source: item.source, messages: item.messages })),
  });
  assert.deepEqual(donation.sessions[0].messages, original);
  assert.equal(donation.redactionSummary.messages, 3);
});
