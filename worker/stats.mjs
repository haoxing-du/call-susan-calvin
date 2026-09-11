// Only completed, still-active donations contribute to public totals.
export const CURRENT_STATS_SQL = `
WITH complete_groups AS (
  SELECT g.id FROM susan_calvin_donation_groups g
  JOIN susan_calvin_donations d ON d.group_id = g.id
  WHERE g.state = 'active'
  GROUP BY g.id HAVING COUNT(*) = g.batch_count
)
SELECT COUNT(DISTINCT CASE WHEN contributor_id IS NOT NULL THEN 'contributor:' || contributor_id
  ELSE 'donation:' || COALESCE(group_id, id) END) AS contributors,
  COALESCE(SUM(session_count), 0) AS sessions,
  COALESCE(SUM(token_count), 0) AS tokens,
  COUNT(*) - COUNT(token_count) AS missing_tokens
FROM susan_calvin_donations
WHERE group_id IS NULL OR group_id IN (SELECT id FROM complete_groups)`;

export const LEGACY_STATS_SQL = `SELECT COUNT(*) AS contributors,
  COALESCE(SUM(d.session_count), 0) AS sessions,
  COALESCE(SUM(t.token_count), 0) AS tokens,
  COUNT(*) - COUNT(t.token_count) AS missing_tokens
FROM research_donations d LEFT JOIN research_donation_token_counts t ON t.donation_id = d.id`;

export async function publicStats(env) {
  try {
    if (!env.DONATION_METADATA) throw new Error("Missing stats database");
    const [current, legacy] = await Promise.all([
      env.DONATION_METADATA.prepare(CURRENT_STATS_SQL).first(),
      env.LEGACY_RESEARCH_DB ? env.LEGACY_RESEARCH_DB.prepare(LEGACY_STATS_SQL).first() : { contributors: 0, sessions: 0, tokens: 0, missing_tokens: 0 },
    ]);
    return Response.json({
      contributors: current.contributors + legacy.contributors,
      sessions: current.sessions + legacy.sessions,
      tokens: current.missing_tokens + legacy.missing_tokens ? null : current.tokens + legacy.tokens,
      updatedAt: new Date().toISOString(),
    }, { headers: { "cache-control": "public, max-age=60" } });
  } catch {
    return Response.json({ error: "Statistics are temporarily unavailable." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
