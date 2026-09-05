import { encryptDonation } from "./donation-crypto.mjs";

export const DONATION_ENDPOINT = "https://donate.susancalvin.org/v1/donations";
const TIMEOUT_MS = 120_000;

export async function submitDonation(value, deletionToken, { endpoint = process.env.CALL_SUSAN_CALVIN_DONATION_URL || DONATION_ENDPOINT, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 5, publicKey } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(deletionToken || "")) throw new Error("Could not create a valid deletion receipt.");
  const encryptedDonation = encryptDonation(value, publicKey);
  const payload = JSON.stringify({ encryptedDonation });
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": deletionToken },
        signal: AbortSignal.timeout(TIMEOUT_MS), body: payload,
      });
    } catch {
      if (attempt + 1 === attempts) throw new Error("Upload interrupted. Retry to continue from the last accepted batch.");
    }
    if (response) {
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        if (body.accepted !== true || !/^[0-9a-f-]{36}$/.test(body.donation_id || "")) throw new Error("The donation service returned an invalid receipt. Retry the upload.");
        return body;
      }
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt + 1 === attempts) throw new Error(body.error || "The donation could not be accepted.");
    }
    const retryAfter = Number(response?.headers.get("retry-after"));
    await sleep(Math.max(1000 * 2 ** attempt, response?.status === 429 ? 60_000 : 0, Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 120_000) : 0));
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

