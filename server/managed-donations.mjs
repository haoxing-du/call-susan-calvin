import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDonationReceipts, loadDonationReceipt, deleteDonationReceipt } from "./store.mjs";
import { deleteDonation } from "./donation-client.mjs";

const legacyRoot = () => path.join(process.env.BEHAVIOR_WRAPPED_STORE_ROOT || path.join(os.homedir(), ".agent-behavior-wrapped"), "donation-receipts");
const validId = (id) => /^[0-9a-f-]{36}$/.test(id || "");

function legacyReceipt(id) {
  if (!validId(id)) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(legacyRoot(), `${id}.json`), "utf8"));
    if (receipt.donationId !== id || !/^[A-Za-z0-9_-]{43}$/.test(receipt.deletionToken || "")) return null;
    return { donationId: id, deletionToken: receipt.deletionToken, savedAt: typeof receipt.savedAt === "string" ? receipt.savedAt : "unknown", origin: "wrapped" };
  } catch { return null; }
}

export function listManagedDonations() {
  let files = [];
  try { files = fs.readdirSync(legacyRoot()); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return [...listDonationReceipts().map(receipt => ({ ...receipt, origin: "susan" })),
    ...files.filter(file => file.endsWith(".json")).flatMap(file => legacyReceipt(file.slice(0, -5)) || [])];
}

export async function deleteManagedDonation(reference, { fetchImpl = fetch, deleteSusan = deleteDonation } = {}) {
  const parts = String(reference || "").split(":");
  const [origin, id] = parts.length === 1 ? [null, parts[0]] : parts;
  if (parts.length > 2 || !validId(id) || (origin && !["wrapped", "susan"].includes(origin))) throw new Error("Use a donation reference from share-with-susan-calvin list.");
  const legacy = origin !== "susan" ? legacyReceipt(id) : null;
  const current = origin !== "wrapped" ? loadDonationReceipt(id) : null;
  if (legacy && current) throw new Error("Both apps have that reference. Use wrapped:<id> or susan:<id> from the list.");
  if (!legacy && !current) throw new Error("That local deletion receipt was not found. Run share-with-susan-calvin list.");
  if (current) {
    await deleteSusan(id, current.deletionToken, { group: current.group === true });
    deleteDonationReceipt(id);
  } else {
    const response = await fetchImpl(`https://behaviorwrapped.com/v1/research-donations/${id}`, {
      method: "DELETE", signal: AbortSignal.timeout(30_000),
      headers: { "x-behavior-wrapped-protocol": "2", "x-behavior-wrapped-deletion-token": legacy.deletionToken },
    });
    const body = await response.json().catch(() => ({}));
    // Legacy deletion returned this exact 404 after a successful, unacknowledged delete.
    if (!response.ok && !(response.status === 404 && body.error === "Donation not found.")) throw new Error(body.error || "The legacy donation could not be deleted. Your receipt has been kept.");
    fs.unlinkSync(path.join(legacyRoot(), `${id}.json`));
  }
}
