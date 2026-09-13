ALTER TABLE operation ALTER COLUMN publication_id DROP NOT NULL;
ALTER TABLE operation ALTER COLUMN quote_id DROP NOT NULL;
ALTER TABLE operation DROP CONSTRAINT IF EXISTS operation_target_check;
ALTER TABLE operation ADD CONSTRAINT operation_target_check CHECK (
  (kind='brand_analysis' AND publication_id IS NULL AND quote_id IS NULL)
  OR (kind<>'brand_analysis' AND publication_id IS NOT NULL AND quote_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS brand_analysis (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id),
  brand_version integer NOT NULL, origin text NOT NULL CHECK(origin IN ('ai_preview','openai')),
  snapshot jsonb NOT NULL, snapshot_hash text NOT NULL,
  credits integer NOT NULL CHECK(credits=3), expires_at timestamptz NOT NULL,
  operation_id uuid UNIQUE REFERENCES operation(id), proposal jsonb, applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_analysis_owner ON brand_analysis(owner_id,created_at DESC);
CREATE OR REPLACE FUNCTION immutable_brand_analysis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['operation_id','proposal','applied']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['operation_id','proposal','applied']) THEN RAISE EXCEPTION 'Accepted analysis inputs are immutable'; END IF;
  IF OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN RAISE EXCEPTION 'Accepted analysis operation is immutable'; END IF;
  IF OLD.proposal IS NOT NULL AND NEW.proposal IS DISTINCT FROM OLD.proposal THEN RAISE EXCEPTION 'Analysis proposal is immutable'; END IF;
  IF OLD.applied AND NOT NEW.applied THEN RAISE EXCEPTION 'Applied analysis cannot rewind'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brand_analysis_immutable ON brand_analysis;
CREATE TRIGGER brand_analysis_immutable BEFORE UPDATE OR DELETE ON brand_analysis FOR EACH ROW EXECUTE FUNCTION immutable_brand_analysis();
