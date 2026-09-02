import { MAX_ENCRYPTED_BYTES, sanitizeEncryptedEnvelope } from "../server/encrypted-donation-schema.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readLimitedBody(request, maximum) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

async function rateLimit(env, key) {
  if (!env.DONATION_RATE_LIMITER?.limit) return true;
  return (await env.DONATION_RATE_LIMITER.limit({ key })).success;
}

function validProtocol(request) {
  return request.headers.get("x-susan-calvin-protocol") === "1";
}

function deletionToken(request) {
  const token = request.headers.get("x-susan-calvin-deletion-token") || "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

async function acceptDonation(request, env) {
  if (!env.DONATION_METADATA || !env.DONATIONS) return json({ error: "Donation storage is not configured." }, 503);
  const token = deletionToken(request);
  if (!token) return json({ error: "A valid deletion token is required." }, 400);
  const networkId = request.headers.get("cf-connecting-ip") || "unknown";
  if (!await rateLimit(env, `donation:${networkId}`)) return json({ error: "Too many donation requests. Try again shortly." }, 429);
  const raw = await readLimitedBody(request, MAX_ENCRYPTED_BYTES);
  if (raw === null) return json({ error: "The encrypted donation is too large." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
  const donation = sanitizeEncryptedEnvelope(body?.encryptedDonation);
  if (!donation) return json({ error: "Invalid encrypted donation." }, 400);
  const tokenHash = await sha256Hex(token);
  const existing = await env.DONATION_METADATA.prepare("SELECT id, deletion_token_hash FROM susan_calvin_donations WHERE donation_run_id = ?").bind(donation.metadata.donationRunId).first();
  if (existing) return existing.deletion_token_hash === tokenHash
    ? json({ accepted: true, donation_id: existing.id, encrypted: true, duplicate: true }, 200)
    : json({ error: "That donation run ID has already been used." }, 409);

  const id = crypto.randomUUID();
  const objectKey = `donations/${donation.metadata.createdAt.slice(0, 7)}/${id}.json`;
  const serialized = JSON.stringify(donation);
  const ciphertextSha256 = await sha256Hex(donation.ciphertext);
  try {
    await env.DONATIONS.put(objectKey, serialized, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { donationId: id, encryptionKeyId: donation.encryption.keyId, collector: "call-susan-calvin" },
    });
  } catch { return json({ error: "Encrypted donation storage is temporarily unavailable." }, 503); }
  try {
    await env.DONATION_METADATA.prepare(`INSERT INTO susan_calvin_donations
      (id, donation_run_id, deletion_token_hash, object_key, encryption_key_id, encryption_algorithm, ciphertext_sha256,
       object_bytes, collector_version, source_types, redaction_mode, unredacted_data, automated_detections,
       session_count, message_count, consent_version, consented_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, donation.metadata.donationRunId, tokenHash, objectKey, donation.encryption.keyId, donation.encryption.algorithm,
        ciphertextSha256, new TextEncoder().encode(serialized).byteLength, donation.metadata.collectorVersion,
        JSON.stringify(donation.metadata.sourceTypes), donation.metadata.redactionMode, donation.metadata.unredactedData ? 1 : 0,
        donation.metadata.automatedDetections, donation.metadata.sessions, donation.metadata.messages,
        donation.metadata.consentVersion, donation.metadata.consentedAt, donation.metadata.createdAt,
      ).run();
  } catch {
    await env.DONATIONS.delete(objectKey).catch(() => {});
    return json({ error: "Donation metadata storage is temporarily unavailable." }, 503);
  }
  return json({ accepted: true, donation_id: id, encrypted: true }, 201);
}

async function removeDonation(request, env, id) {
  if (!env.DONATION_METADATA || !env.DONATIONS) return json({ error: "Donation storage is not configured." }, 503);
  const token = deletionToken(request);
  if (!token) return json({ error: "A valid deletion token is required." }, 400);
  const networkId = request.headers.get("cf-connecting-ip") || "unknown";
  if (!await rateLimit(env, `deletion:${networkId}`)) return json({ error: "Too many deletion requests. Try again shortly." }, 429);
  const record = await env.DONATION_METADATA.prepare("SELECT object_key FROM susan_calvin_donations WHERE id = ? AND deletion_token_hash = ?").bind(id, await sha256Hex(token)).first();
  if (!record?.object_key) return json({ error: "Donation not found." }, 404);
  try { await env.DONATIONS.delete(record.object_key); }
  catch { return json({ error: "Encrypted donation storage is temporarily unavailable." }, 503); }
  await env.DONATION_METADATA.prepare("DELETE FROM susan_calvin_donations WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "susan-calvin-donations", healthy: true });
  if (url.pathname === "/v1/donations") {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (!validProtocol(request)) return json({ error: "Encrypted donation protocol 1 is required." }, 426);
    return acceptDonation(request, env);
  }
  const match = url.pathname.match(/^\/v1\/donations\/([0-9a-f-]{36})$/);
  if (match) {
    if (request.method !== "DELETE") return json({ error: "Method not allowed." }, 405);
    if (!validProtocol(request)) return json({ error: "Unsupported donation protocol." }, 400);
    return removeDonation(request, env, match[1]);
  }
  return json({ error: "Not found." }, 404);
}

export default { fetch: handleRequest };

