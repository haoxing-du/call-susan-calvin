import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const storeRoot = process.env.CALL_SUSAN_CALVIN_STORE_ROOT || path.join(os.homedir(), ".call-susan-calvin");
export const receiptsRoot = path.join(storeRoot, "donation-receipts");

function ensureStore() {
  fs.mkdirSync(receiptsRoot, { recursive: true, mode: 0o700 });
}

function validId(value) {
  return /^[0-9a-f-]{36}$/.test(value || "");
}

function validToken(value) {
  return /^[A-Za-z0-9_-]{43}$/.test(value || "");
}

export function createDeletionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function saveDonationReceipt(value) {
  if (!validId(value?.donationId) || !validToken(value?.deletionToken)) throw new Error("The donation service returned an invalid deletion receipt.");
  ensureStore();
  const receipt = {
    donationId: value.donationId,
    ...(value.group ? { group: true } : {}),
    deletionToken: value.deletionToken,
    donationRunId: String(value.donationRunId || "").slice(0, 64),
    sourceTypes: Array.isArray(value.sourceTypes) ? value.sourceTypes.filter((item) => ["claude", "cowork", "codex"].includes(item)) : [],
    sessionCount: Math.max(1, Number(value.sessionCount) || 1),
    savedAt: new Date().toISOString(),
  };
  const target = path.join(receiptsRoot, `${receipt.donationId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
  return receipt;
}

export function loadDonationReceipt(id) {
  if (!validId(id)) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptsRoot, `${id}.json`), "utf8"));
    return validId(receipt.donationId) && validToken(receipt.deletionToken) ? receipt : null;
  } catch { return null; }
}

export function listDonationReceipts() {
  ensureStore();
  return fs.readdirSync(receiptsRoot).filter((name) => name.endsWith(".json")).flatMap((name) => {
    const receipt = loadDonationReceipt(name.slice(0, -5));
    return receipt ? [receipt] : [];
  }).sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

export function deleteDonationReceipt(id) {
  if (!validId(id)) return false;
  const file = path.join(receiptsRoot, `${id}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

