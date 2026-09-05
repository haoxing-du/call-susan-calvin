import crypto from "node:crypto";
import { encryptedStoragePrefix } from "./encrypted-donation-schema.mjs";
import { encryptDonation } from "./donation-crypto.mjs";

export const DONATION_ENDPOINT = "https://donate.susancalvin.org/v1/donations";
const TIMEOUT_MS = 120_000;
const stopped = () => new Error("Upload stopped. The saved receipt can delete any accepted batches.");
function retryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const abort = () => { clearTimeout(timer); reject(stopped()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function submitDonation(value, deletionToken, { endpoint = process.env.CALL_SUSAN_CALVIN_DONATION_URL || DONATION_ENDPOINT, fetchImpl = fetch, sleep = retryDelay, attempts = 8, publicKey, signal } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(deletionToken || "")) throw new Error("Could not create a valid deletion receipt.");
  const encryptedDonation = encryptDonation(value, publicKey);
  const { ciphertext, ...header } = encryptedDonation;
  const payload = Buffer.from(ciphertext, "base64url");
  const objectHash = crypto.createHash("sha256").update(encryptedStoragePrefix(header)).update(payload).digest("hex");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw stopped();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let response, body;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-susan-calvin-protocol": "2", "x-susan-calvin-deletion-token": deletionToken, "x-susan-calvin-envelope": JSON.stringify(header), "x-susan-calvin-ciphertext-bytes": String(payload.length), "x-susan-calvin-object-sha256": objectHash },
        signal: controller.signal, body: payload,
      });
      body = await response.json().catch((error) => { if (controller.signal.aborted) throw error; return {}; });
    } catch {
      response = undefined;
      if (signal?.aborted) throw stopped();
      if (attempt + 1 === attempts) throw new Error("Upload interrupted. Retry to continue from the last accepted batch.");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    if (response) {
      if (response.ok) {
        if (body.accepted !== true || !/^[0-9a-f-]{36}$/.test(body.donation_id || "")) throw new Error("The donation service returned an invalid receipt. Retry the upload.");
        return body;
      }
      if (!(response.status === 408 || response.status === 429 || response.status >= 500) || attempt + 1 === attempts) throw new Error(`${body.error || "The donation could not be accepted."} (HTTP ${response.status})`);
    }
    const retryAfter = Number(response?.headers.get("retry-after"));
    await sleep(Math.max(Math.min(1000 * 2 ** attempt, 60_000), response?.status === 429 ? 60_000 : 0, Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 120_000) : 0), signal);
  }
}

export async function deleteDonation(id, deletionToken, { endpoint = process.env.CALL_SUSAN_CALVIN_DONATION_URL || DONATION_ENDPOINT, fetchImpl = fetch, group = false } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(id || "") || !/^[A-Za-z0-9_-]{43}$/.test(deletionToken || "")) throw new Error("The local deletion receipt is invalid.");
  let response;
  try {
    response = await fetchImpl(`${group ? endpoint.replace(/\/donations$/, "/donation-groups") : endpoint}/${id}`, {
      method: "DELETE",
      headers: { "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": deletionToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new Error("The Susan Calvin donation service is temporarily unavailable."); }
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return { deleted: true };
  if (!response.ok) throw new Error(body.error || "The donation could not be deleted.");
  if (body.deleted !== true && body.remaining !== true) throw new Error("The donation service did not confirm deletion.");
  if (body.remaining) return deleteDonation(id, deletionToken, { endpoint, fetchImpl, group });
  return body;
}

