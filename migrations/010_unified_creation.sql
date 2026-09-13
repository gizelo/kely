ALTER TABLE operation DROP CONSTRAINT IF EXISTS operation_status_check;
ALTER TABLE operation ADD CONSTRAINT operation_status_check CHECK(status IN ('queued','running','completed','failed','uncertain','waiting_input'));

CREATE TABLE IF NOT EXISTS creation_run (
  operation_id uuid PRIMARY KEY REFERENCES operation(id),
  owner_id text NOT NULL REFERENCES "user"(id),
  publication_id uuid NOT NULL REFERENCES publication(id),
  state jsonb NOT NULL,
  text_replies integer NOT NULL DEFAULT 0 CHECK(text_replies BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creation_run_publication ON creation_run(owner_id,publication_id);

CREATE TABLE IF NOT EXISTS creation_step (
  operation_id uuid NOT NULL REFERENCES creation_run(operation_id),
  step_key text NOT NULL,
  input jsonb NOT NULL,
  input_hash text NOT NULL,
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(operation_id,step_key)
);
CREATE OR REPLACE FUNCTION immutable_creation_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'output') IS DISTINCT FROM (to_jsonb(OLD)-'output')
    OR (OLD.output IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output) THEN
    RAISE EXCEPTION 'Creation step evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS creation_step_immutable ON creation_step;
CREATE TRIGGER creation_step_immutable BEFORE UPDATE OR DELETE ON creation_step FOR EACH ROW EXECUTE FUNCTION immutable_creation_step();

CREATE TABLE IF NOT EXISTS creation_answer (
  operation_id uuid NOT NULL REFERENCES creation_run(operation_id),
  request_key text NOT NULL,
  publication_version integer NOT NULL,
  message text NOT NULL,
  resulting_version integer NOT NULL,
  PRIMARY KEY(operation_id,request_key)
);
