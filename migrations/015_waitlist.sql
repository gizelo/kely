DROP TRIGGER IF EXISTS protect_kely_public_signup_trigger ON "user";
DROP FUNCTION IF EXISTS protect_kely_public_signup();

CREATE TABLE IF NOT EXISTS waitlist_entry (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source = 'landing'),
  consent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS waitlist_created_idx ON waitlist_entry(created_at DESC);

CREATE TABLE IF NOT EXISTS operator_access_event (
  id uuid PRIMARY KEY,
  command_key text NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES "user"(id),
  action text NOT NULL CHECK (action IN ('create','grant','revoke')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION immutable_operator_access_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Operator access events are append-only'; END $$;
DROP TRIGGER IF EXISTS operator_access_event_immutable ON operator_access_event;
CREATE TRIGGER operator_access_event_immutable BEFORE UPDATE OR DELETE ON operator_access_event FOR EACH ROW EXECUTE FUNCTION immutable_operator_access_event();
