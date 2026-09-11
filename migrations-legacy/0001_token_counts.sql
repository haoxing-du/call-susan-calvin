CREATE TABLE IF NOT EXISTS research_donation_token_counts (
  donation_id TEXT PRIMARY KEY,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  token_encoding TEXT NOT NULL
);
