// Legacy objects retain their original schema, consent and storage locations.
export async function deleteLegacyDonation(request, env, id) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!env.LEGACY_RESEARCH_DB || !env.LEGACY_RESEARCH_DONATIONS) return json({ error: "Legacy donation storage is not configured." }, 503);
  if (env.DONATION_RATE_LIMITER && !(await env.DONATION_RATE_LIMITER.limit({ key: `legacy-delete:${request.headers.get("cf-connecting-ip") || "unknown"}` })).success) return json({ error: "Too many deletion requests. Try again shortly." }, 429);
  const token = request.headers.get("x-behavior-wrapped-deletion-token") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: "A valid deletion token is required." }, 400);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
  const record = await env.LEGACY_RESEARCH_DB.prepare("SELECT object_key FROM research_donations WHERE id = ? AND deletion_token_hash = ?").bind(id, hash).first();
  if (!record?.object_key) return json({ error: "Donation not found." }, 404);
  try { await env.LEGACY_RESEARCH_DONATIONS.delete(record.object_key); }
  catch { return json({ error: "Encrypted research storage is temporarily unavailable." }, 503); }
  await env.LEGACY_RESEARCH_DB.prepare("DELETE FROM research_donations WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}
