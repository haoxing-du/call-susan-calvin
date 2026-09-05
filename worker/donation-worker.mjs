import { enqueueNotification, deliverNotifications, reconcileNotifications } from "./notifications.mjs";
import { MAX_ENCRYPTED_BYTES, MAX_COMPRESSED_BYTES, sanitizeEncryptedEnvelope, sanitizeEncryptedHeader, encryptedStoragePrefix } from "../server/encrypted-donation-schema.mjs";

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
  return ["1", "2"].includes(request.headers.get("x-susan-calvin-protocol"));
}

function deletionToken(request) {
  const token = request.headers.get("x-susan-calvin-deletion-token") || "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

async function acceptDonation(request, env, context) {
  if (!env.DONATION_METADATA || !env.DONATIONS) return json({ error: "Donation storage is not configured." }, 503);
  const token = deletionToken(request);
  if (!token) return json({ error: "A valid deletion token is required." }, 400);
  const networkId = request.headers.get("cf-connecting-ip") || "unknown";
  const streamed = request.headers.get("x-susan-calvin-protocol") === "2";
  let donation, ciphertextBytes = 0, objectHash = null;
  if (streamed) {
    const encoded = request.headers.get("x-susan-calvin-envelope") || "";
    if (encoded.length > 8_000) return json({ error: "Encrypted header is too large." }, 413);
    try { donation = sanitizeEncryptedHeader(JSON.parse(encoded)); } catch { /* Rejected below. */ }
    ciphertextBytes = Number(request.headers.get("x-susan-calvin-ciphertext-bytes"));
    objectHash = request.headers.get("x-susan-calvin-object-sha256") || "";
    if (!request.body || !Number.isInteger(ciphertextBytes) || ciphertextBytes < 1 || ciphertextBytes > MAX_COMPRESSED_BYTES || !/^[a-f0-9]{64}$/.test(objectHash)) return json({ error: "Invalid encrypted stream size or checksum." }, 400);
  } else {
    const raw = await readLimitedBody(request, MAX_ENCRYPTED_BYTES);
    if (raw === null) return json({ error: "The encrypted donation is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
    donation = sanitizeEncryptedEnvelope(body?.encryptedDonation);
  }
  if (!donation) return json({ error: "Invalid encrypted donation." }, 400);
  const tokenHash = await sha256Hex(token);
  const existing = await env.DONATION_METADATA.prepare("SELECT id, deletion_token_hash, group_id, batch_index FROM susan_calvin_donations WHERE donation_run_id = ?").bind(donation.metadata.donationRunId).first();
  if (existing) {
    if (existing.deletion_token_hash !== tokenHash) return json({ error: "That donation run ID has already been used." }, 409);
    if ((existing.group_id || null) !== (donation.metadata.groupId || null) || (existing.group_id && existing.batch_index !== donation.metadata.batchIndex)) return json({ error: "That donation run ID belongs to another batch." }, 409);
    if (existing.group_id) {
      const group = await env.DONATION_METADATA.prepare("SELECT * FROM susan_calvin_donation_groups WHERE id = ?").bind(existing.group_id).first();
      if (group?.state !== "active") return json({ error: "Donation group is closed." }, 409);
    }
    await enqueueNotification(env, donation.metadata, existing.id);
    context?.waitUntil(deliverNotifications(env));
    return json({ accepted: true, donation_id: existing.id, encrypted: true, duplicate: true });
  }
  const metadata = donation.metadata;
  if (metadata.groupId) {
    let group = await env.DONATION_METADATA.prepare("SELECT * FROM susan_calvin_donation_groups WHERE id = ?").bind(metadata.groupId).first();
    if (!group) {
      if (!await rateLimit(env, `donation:${networkId}`)) return json({ error: "Too many donation requests. Try again shortly." }, 429);
      await env.DONATION_METADATA.prepare("INSERT OR IGNORE INTO susan_calvin_donation_groups (id, deletion_token_hash, batch_count, redaction_mode) VALUES (?, ?, ?, ?)").bind(metadata.groupId, tokenHash, metadata.batchCount, metadata.redactionMode).run();
      group = await env.DONATION_METADATA.prepare("SELECT * FROM susan_calvin_donation_groups WHERE id = ?").bind(metadata.groupId).first();
    }
    if (group.deletion_token_hash !== tokenHash || group.batch_count !== metadata.batchCount || group.redaction_mode !== metadata.redactionMode || group.state !== "active") return json({ error: "Donation batch does not match its group." }, 409);
    if (env.BATCH_RATE_LIMITER && !(await env.BATCH_RATE_LIMITER.limit({ key: metadata.groupId })).success) return json({ error: "Upload paused briefly. Retrying is safe." }, 429);
  } else if (!await rateLimit(env, `donation:${networkId}`)) return json({ error: "Too many donation requests. Try again shortly." }, 429);

  const id = crypto.randomUUID();
  const objectKey = `donations/${donation.metadata.createdAt.slice(0, 7)}/${id}.${streamed ? "bin" : "json"}`;
  const prefix = streamed ? encryptedStoragePrefix(donation) : null;
  const serialized = streamed ? null : JSON.stringify(donation);
  const objectBytes = streamed ? prefix.length + ciphertextBytes : new TextEncoder().encode(serialized).byteLength;
  const ciphertextSha256 = streamed ? "" : await sha256Hex(donation.ciphertext);
  try {
    const options = {
      httpMetadata: { contentType: streamed ? "application/octet-stream" : "application/json" },
      customMetadata: { donationId: id, encryptionKeyId: donation.encryption.keyId, collector: "share-with-susan-calvin" },
      ...(streamed ? { sha256: objectHash } : {}),
    };
    if (streamed) {
      // The runtime pipes ciphertext natively. R2 checks the checksum and fixed length;
      // no transcript-sized buffer, JSON parse, regex or hash runs in the Worker.
      const stream = new FixedLengthStream(objectBytes);
      const transfer = (async () => {
        const writer = stream.writable.getWriter();
        await writer.write(prefix);
        writer.releaseLock();
        await request.body.pipeTo(stream.writable);
      })();
      await Promise.all([env.DONATIONS.put(objectKey, stream.readable, options), transfer]);
    } else await env.DONATIONS.put(objectKey, serialized, options);
  } catch { return json({ error: "Encrypted storage rejected the upload or is temporarily unavailable. Retry the same batch." }, 503); }
  try {
    const inserted = await env.DONATION_METADATA.prepare(`INSERT INTO susan_calvin_donations
      (id, donation_run_id, deletion_token_hash, object_key, encryption_key_id, encryption_algorithm, ciphertext_sha256,
       object_bytes, collector_version, source_types, redaction_mode, unredacted_data, automated_detections,
       session_count, message_count, consent_version, consented_at, created_at, group_id, batch_index, object_sha256)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ? IS NULL OR EXISTS (SELECT 1 FROM susan_calvin_donation_groups WHERE id = ? AND state = 'active')`).bind(
        id, donation.metadata.donationRunId, tokenHash, objectKey, donation.encryption.keyId, donation.encryption.algorithm,
        ciphertextSha256, objectBytes, donation.metadata.collectorVersion,
        JSON.stringify(donation.metadata.sourceTypes), donation.metadata.redactionMode, donation.metadata.unredactedData ? 1 : 0,
        donation.metadata.automatedDetections, donation.metadata.sessions, donation.metadata.messages,
        donation.metadata.consentVersion, donation.metadata.consentedAt, donation.metadata.createdAt, donation.metadata.groupId || null, donation.metadata.batchIndex ?? null, objectHash, donation.metadata.groupId || null, donation.metadata.groupId || null,
      ).run();
    if (inserted.meta?.changes === 0) {
      await env.DONATIONS.delete(objectKey);
      return json({ error: "Donation group is closed." }, 409);
    }
  } catch {
    await env.DONATIONS.delete(objectKey).catch(() => {});
    return json({ error: "Donation metadata storage is temporarily unavailable." }, 503);
  }
  await enqueueNotification(env, donation.metadata, id);
  context?.waitUntil(deliverNotifications(env));
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

async function removeGroup(request, env, id) {
  const token = deletionToken(request);
  if (!token) return json({ error: "A valid deletion token is required." }, 400);
  const group = await env.DONATION_METADATA.prepare("SELECT * FROM susan_calvin_donation_groups WHERE id = ? AND deletion_token_hash = ?").bind(id, await sha256Hex(token)).first();
  if (!group) return json({ error: "Donation not found." }, 404);
  await env.DONATION_METADATA.prepare("UPDATE susan_calvin_donation_groups SET state = 'deleting' WHERE id = ?").bind(id).run();
  const { results } = await env.DONATION_METADATA.prepare("SELECT id, object_key FROM susan_calvin_donations WHERE group_id = ? LIMIT 5").bind(id).all();
  for (const row of results) {
    await env.DONATIONS.delete(row.object_key);
    await env.DONATION_METADATA.prepare("DELETE FROM susan_calvin_donations WHERE id = ?").bind(row.id).run();
  }
  await env.DONATION_METADATA.prepare("DELETE FROM susan_calvin_notifications WHERE id = ?").bind(id).run();
  return json({ deleted: results.length < 5, remaining: results.length === 5 });
}

export async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ service: "susan-calvin-donations", healthy: true });
  if (url.pathname === "/v1/donations") {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (!validProtocol(request)) return json({ error: "Encrypted donation protocol 1 or 2 is required." }, 426);
    try { return await acceptDonation(request, env, context); } catch { return json({ error: "Donation service is temporarily unavailable. Retrying is safe." }, 503); }
  }
  const groupMatch = url.pathname.match(/^\/v1\/donation-groups\/([0-9a-f-]{36})$/);
  if (groupMatch && request.method === "DELETE" && validProtocol(request)) {
    try { return await removeGroup(request, env, groupMatch[1]); } catch { return json({ error: "Deletion interrupted. Retrying is safe." }, 503); }
  }
  const match = url.pathname.match(/^\/v1\/donations\/([0-9a-f-]{36})$/);
  if (match) {
    if (request.method !== "DELETE") return json({ error: "Method not allowed." }, 405);
    if (!validProtocol(request)) return json({ error: "Unsupported donation protocol." }, 400);
    return removeDonation(request, env, match[1]);
  }
  return json({ error: "Not found." }, 404);
}

export default { fetch: handleRequest, scheduled(_event, env, context) { context.waitUntil((async () => { await reconcileNotifications(env); await deliverNotifications(env); })()); } };

