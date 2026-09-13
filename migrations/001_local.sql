CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, image text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, ip_address text, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(user_id);
CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  account_id text NOT NULL, provider_id text NOT NULL, access_token text, refresh_token text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz, scope text, id_token text, password text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id, account_id)
);
CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS business (
  id uuid PRIMARY KEY, owner_id text NOT NULL UNIQUE REFERENCES "user"(id),
  name text NOT NULL, context text NOT NULL DEFAULT '', website text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS credit_account (
  owner_id text PRIMARY KEY REFERENCES "user"(id),
  tier text NOT NULL DEFAULT 'none' CHECK (tier IN ('none','starter','studio')),
  cadence text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly','annual')),
  anchor_at timestamptz, active_until timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS credit_bucket (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES credit_account(owner_id),
  kind text NOT NULL CHECK (kind IN ('weekly','pack')), window_key text NOT NULL,
  remaining integer NOT NULL CHECK (remaining >= 0), reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, window_key)
);
CREATE INDEX IF NOT EXISTS credit_bucket_owner_idx ON credit_bucket(owner_id);
CREATE TABLE IF NOT EXISTS publication (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), state jsonb NOT NULL,
  version integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publication_owner_idx ON publication(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS publication_version (
  publication_id uuid NOT NULL REFERENCES publication(id), version integer NOT NULL, state jsonb NOT NULL,
  PRIMARY KEY(publication_id, version)
);
CREATE TABLE IF NOT EXISTS quote (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), publication_id uuid NOT NULL REFERENCES publication(id),
  kind text NOT NULL, publication_version integer NOT NULL, credits integer NOT NULL CHECK (credits > 0),
  instruction text NOT NULL DEFAULT '', business_context jsonb NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL, accepted_operation_id uuid
);
CREATE TABLE IF NOT EXISTS operation (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), publication_id uuid NOT NULL REFERENCES publication(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES quote(id), request_key text NOT NULL,
  kind text NOT NULL, status text NOT NULL CHECK(status IN ('queued','running','completed','failed','uncertain')),
  input_state jsonb NOT NULL, business_context jsonb NOT NULL DEFAULT '{}', instruction text NOT NULL DEFAULT '', error text, queue_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, request_key)
);
CREATE TABLE IF NOT EXISTS credit_reservation (
  operation_id uuid NOT NULL REFERENCES operation(id), bucket_id uuid NOT NULL REFERENCES credit_bucket(id),
  amount integer NOT NULL CHECK(amount > 0), settled boolean NOT NULL DEFAULT false,
  PRIMARY KEY(operation_id, bucket_id)
);
CREATE TABLE IF NOT EXISTS credit_entry (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), bucket_id uuid REFERENCES credit_bucket(id),
  kind text NOT NULL, amount integer NOT NULL, reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id, reference)
);
CREATE TABLE IF NOT EXISTS asset (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), publication_id uuid NOT NULL REFERENCES publication(id),
  filename text NOT NULL, mime_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
