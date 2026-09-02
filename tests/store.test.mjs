import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("deletion receipts use owner-only filesystem permissions", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "call-susan-calvin-store-"));
  process.env.CALL_SUSAN_CALVIN_STORE_ROOT = temporary;
  const store = await import(`../server/store.mjs?test=${Date.now()}`);
  const donationId = "66666666-6666-4666-8666-666666666666";
  store.saveDonationReceipt({ donationId, deletionToken: "s".repeat(43), donationRunId: "77777777-7777-4777-8777-777777777777", sourceTypes: ["codex"], sessionCount: 2 });
  const directoryMode = fs.statSync(store.receiptsRoot).mode & 0o777;
  const receiptMode = fs.statSync(path.join(store.receiptsRoot, `${donationId}.json`)).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(receiptMode, 0o600);
  assert.equal(store.listDonationReceipts().length, 1);
  assert.equal(store.deleteDonationReceipt(donationId), true);
});

