export async function enqueueNotification(env, metadata, id) {
  let payload;
  if (metadata.groupId) {
    const row = await env.DONATION_METADATA.prepare(`SELECT COUNT(*) AS batches, SUM(session_count) AS sessions, SUM(message_count) AS messages, SUM(automated_detections) AS automatedDetections FROM susan_calvin_donations WHERE group_id = ? AND EXISTS (SELECT 1 FROM susan_calvin_donation_groups WHERE id = group_id AND state = 'active')`).bind(metadata.groupId).first();
    if (row.batches !== metadata.batchCount) return;
    payload = { sessions: row.sessions, messages: row.messages, automatedDetections: row.automatedDetections, redactionMode: metadata.redactionMode };
  } else payload = { sessions: metadata.sessions, messages: metadata.messages, automatedDetections: metadata.automatedDetections, redactionMode: metadata.redactionMode };
  await env.DONATION_METADATA.prepare("INSERT OR IGNORE INTO susan_calvin_notifications (id, payload) VALUES (?, ?)").bind(metadata.groupId || id, JSON.stringify(payload)).run();
}

export async function deliverNotifications(env) {
  if (!env.ZULIP_NOTIFIER?.notifyDonation) return;
  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DONATION_METADATA.prepare("SELECT id, payload FROM susan_calvin_notifications WHERE delivered_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?) LIMIT 20").bind(now - 120).all();
  for (const row of results) {
    const claimed = await env.DONATION_METADATA.prepare("UPDATE susan_calvin_notifications SET claimed_at = ? WHERE id = ? AND delivered_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)").bind(now, row.id, now - 120).run();
    if (!claimed.meta?.changes) continue;
    try {
      const result = await env.ZULIP_NOTIFIER.notifyDonation(JSON.parse(row.payload));
      if (!result?.sent) throw new Error("Notification service is not configured");
      await env.DONATION_METADATA.prepare("UPDATE susan_calvin_notifications SET delivered_at = ? WHERE id = ?").bind(now, row.id).run();
    } catch {
      await env.DONATION_METADATA.prepare("UPDATE susan_calvin_notifications SET claimed_at = NULL WHERE id = ?").bind(row.id).run();
      console.error(JSON.stringify({ event: "donation_notification_failed", retry: "scheduled" }));
    }
  }
}

// Recover the small window between storing a donation and inserting its outbox row.
// This also delivers alerts for donations accepted before notifications were configured.
export async function reconcileNotifications(env) {
  const { results } = await env.DONATION_METADATA.prepare(`SELECT MIN(d.id) AS id, d.group_id,
    MAX(g.batch_count) AS batch_count, d.redaction_mode, SUM(d.session_count) AS sessions,
    SUM(d.message_count) AS messages, SUM(d.automated_detections) AS automated_detections
    FROM susan_calvin_donations d LEFT JOIN susan_calvin_donation_groups g ON g.id = d.group_id
    WHERE (g.state IS NULL OR g.state = 'active')
      AND NOT EXISTS (SELECT 1 FROM susan_calvin_notifications n WHERE n.id = COALESCE(d.group_id, d.id))
    GROUP BY COALESCE(d.group_id, d.id)
    HAVING COUNT(*) = COALESCE(MAX(g.batch_count), 1) LIMIT 20`).all();
  for (const row of results) await enqueueNotification(env, {
    ...(row.group_id ? { groupId: row.group_id, batchCount: row.batch_count } : {}),
    sessions: row.sessions, messages: row.messages, automatedDetections: row.automated_detections, redactionMode: row.redaction_mode,
  }, row.id);
}
