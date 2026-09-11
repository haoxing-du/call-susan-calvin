ALTER TABLE susan_calvin_donation_groups ADD COLUMN contributor_id TEXT;
ALTER TABLE susan_calvin_donations ADD COLUMN contributor_id TEXT;
ALTER TABLE susan_calvin_donations ADD COLUMN token_count INTEGER CHECK (token_count >= 0);
ALTER TABLE susan_calvin_donations ADD COLUMN token_encoding TEXT;
CREATE INDEX donation_contributor ON susan_calvin_donations(contributor_id);
