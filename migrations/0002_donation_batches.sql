CREATE TABLE susan_calvin_donation_groups (
  id TEXT PRIMARY KEY,
  deletion_token_hash TEXT NOT NULL,
  batch_count INTEGER NOT NULL,
  redaction_mode TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
);
ALTER TABLE susan_calvin_donations ADD COLUMN group_id TEXT;
ALTER TABLE susan_calvin_donations ADD COLUMN batch_index INTEGER;
CREATE UNIQUE INDEX donation_group_batch ON susan_calvin_donations(group_id, batch_index);
CREATE TABLE susan_calvin_notifications (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  claimed_at INTEGER,
  delivered_at INTEGER
);
CREATE INDEX pending_notifications ON susan_calvin_notifications(delivered_at, claimed_at);
