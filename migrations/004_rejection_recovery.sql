CREATE TABLE IF NOT EXISTS operation_recovery (
  operation_id uuid PRIMARY KEY REFERENCES operation(id),
  owner_id text NOT NULL REFERENCES "user"(id),
  publication_id uuid NOT NULL REFERENCES publication(id),
  review_id text NOT NULL UNIQUE,
  plan_hash text NOT NULL,
  marker jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION kely_protect_operation_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Operation recovery records are immutable';
END;
$$;
DROP TRIGGER IF EXISTS operation_recovery_immutable ON operation_recovery;
CREATE TRIGGER operation_recovery_immutable BEFORE UPDATE OR DELETE ON operation_recovery FOR EACH ROW EXECUTE FUNCTION kely_protect_operation_recovery();
