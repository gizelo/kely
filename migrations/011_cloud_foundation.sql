CREATE TABLE cloud_storage_quota (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  ceiling_bytes bigint NOT NULL DEFAULT 200000000 CHECK (ceiling_bytes = 200000000),
  CHECK (used_bytes + reserved_bytes <= ceiling_bytes)
);
INSERT INTO cloud_storage_quota(singleton) VALUES(true);

CREATE TABLE cloud_output_reservation (
  operation_id text PRIMARY KEY,
  remaining_bytes bigint NOT NULL CHECK(remaining_bytes >= 0)
);

CREATE TABLE private_blob (
  namespace text NOT NULL CHECK(namespace IN ('material','asset')),
  name text NOT NULL,
  content bytea NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(namespace,name)
);

CREATE TABLE cloud_budget_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  identity jsonb NOT NULL,
  destination text NOT NULL,
  imported_hash text NOT NULL,
  imported_sequence integer NOT NULL CHECK(imported_sequence > 0),
  active boolean NOT NULL DEFAULT false,
  evidence_reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(evidence_reserved_bytes >= 0)
);
CREATE TABLE cloud_budget_event (
  sequence integer PRIMARY KEY,
  payload text NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL
);
CREATE FUNCTION reject_cloud_budget_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Budget history is immutable'; END $$;
CREATE TRIGGER cloud_budget_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON cloud_budget_event
  FOR EACH STATEMENT EXECUTE FUNCTION reject_cloud_budget_history_change();

CREATE FUNCTION protect_cloud_budget_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Budget identity is immutable'; END IF;
  IF NEW.identity IS DISTINCT FROM OLD.identity OR NEW.destination IS DISTINCT FROM OLD.destination
    OR NEW.imported_hash IS DISTINCT FROM OLD.imported_hash OR NEW.imported_sequence IS DISTINCT FROM OLD.imported_sequence THEN
    RAISE EXCEPTION 'Budget identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_budget_identity_no_change BEFORE UPDATE OR DELETE ON cloud_budget_authority
  FOR EACH ROW EXECUTE FUNCTION protect_cloud_budget_identity();
CREATE TRIGGER cloud_budget_identity_no_truncate BEFORE TRUNCATE ON cloud_budget_authority
  FOR EACH STATEMENT EXECUTE FUNCTION reject_cloud_budget_history_change();
