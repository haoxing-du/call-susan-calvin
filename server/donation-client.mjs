import { encryptDonation } from "./donation-crypto.mjs";

export const DONATION_ENDPOINT = "https://donate.susancalvin.org/v1/donations";
const TIMEOUT_MS = 30_000;

export async function submitDonation(value, deletionToken, { endpoint = process.env.CALL_SUSAN_CALVIN_DONATION_URL || DONATION_ENDPOINT, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(deletionToken || "")) throw new Error("Could not create a valid deletion receipt.");
  const encryptedDonation = encryptDonation(value);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-susan-calvin-protocol": "1",
        "x-susan-calvin-deletion-token": deletionToken,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ encryptedDonation }),
    });
  } catch (error) {
    if (["AbortError", "TimeoutError"].includes(error?.name)) throw new Error("The donation timed out. Retrying with the same reviewed bundle is safe.");
    throw new Error("The Susan Calvin donation service is temporarily unavailable.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The donation could not be accepted.");
  return body;
}

export async function deleteDonation(id, deletionToken, { endpoint = process.env.CALL_SUSAN_CALVIN_DONATION_URL || DONATION_ENDPOINT, fetchImpl = fetch } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(id || "") || !/^[A-Za-z0-9_-]{43}$/.test(deletionToken || "")) throw new Error("The local deletion receipt is invalid.");
  let response;
  try {
    response = await fetchImpl(`${endpoint}/${id}`, {
      method: "DELETE",
      headers: { "x-susan-calvin-protocol": "1", "x-susan-calvin-deletion-token": deletionToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new Error("The Susan Calvin donation service is temporarily unavailable."); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The donation could not be deleted.");
  return body;
}

