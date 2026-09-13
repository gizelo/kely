CREATE TABLE IF NOT EXISTS beta_access_token (
  token_hash text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('invite','recover')),
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beta_access_email_idx ON beta_access_token(email);
CREATE TABLE IF NOT EXISTS beta_rate_limit (
  key text NOT NULL,
  window_minute bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(key,window_minute)
);
