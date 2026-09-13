ALTER TABLE credit_account ADD COLUMN IF NOT EXISTS pending_tier text CHECK (pending_tier IN ('starter','studio'));
ALTER TABLE credit_account ADD COLUMN IF NOT EXISTS pending_cadence text CHECK (pending_cadence IN ('monthly','annual'));

CREATE TABLE IF NOT EXISTS simulated_billing_event (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES credit_account(owner_id),
  event_key text NOT NULL,
  action text NOT NULL CHECK (action='renew'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,event_key)
);

CREATE OR REPLACE FUNCTION immutable_simulated_billing_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Simulated billing events are append-only'; END $$;
DROP TRIGGER IF EXISTS simulated_billing_event_immutable ON simulated_billing_event;
CREATE TRIGGER simulated_billing_event_immutable BEFORE UPDATE OR DELETE ON simulated_billing_event FOR EACH ROW EXECUTE FUNCTION immutable_simulated_billing_event();
