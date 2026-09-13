ALTER TABLE brand_event DROP CONSTRAINT IF EXISTS brand_event_field_check;
ALTER TABLE brand_event ADD CONSTRAINT brand_event_field_check CHECK(field IN ('audience','palette','headlines','artDirection','voice','sourceStrategy'));

CREATE TABLE IF NOT EXISTS brand_source (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  kind text NOT NULL CHECK(kind IN ('website','social','direct_url','upload')),
  role text NOT NULL CHECK(role IN ('reference','original')),
  label text NOT NULL,
  submitted_url text,
  canonical_url text,
  acquisition_state text NOT NULL CHECK(acquisition_state IN ('available','partial','needs_upload')),
  outcome_code text NOT NULL CHECK(outcome_code IN ('upload_normalized','direct_image_imported','page_preview_imported','page_preview_missing','social_preview_partial','social_preview_missing')),
  fallback_for uuid,
  resulting_brand_version integer NOT NULL CHECK(resulting_brand_version >= 1),
  acquired_at timestamptz,
  command_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,command_key),
  FOREIGN KEY(owner_id,fallback_for) REFERENCES brand_source(owner_id,id),
  CHECK ((kind='upload') = (submitted_url IS NULL)),
  CHECK (role='reference' OR kind='upload'),
  CHECK ((acquired_at IS NOT NULL) = (acquisition_state <> 'needs_upload'))
);
CREATE INDEX IF NOT EXISTS brand_source_owner ON brand_source(owner_id,created_at,id);
CREATE INDEX IF NOT EXISTS brand_source_fallback ON brand_source(owner_id,fallback_for);

ALTER TABLE brand_material ADD COLUMN IF NOT EXISTS source_id uuid;
DO $$ BEGIN
  ALTER TABLE brand_material ADD CONSTRAINT brand_material_source_owner_fk
    FOREIGN KEY(owner_id,source_id) REFERENCES brand_source(owner_id,id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION immutable_brand_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'archived_at') IS DISTINCT FROM (to_jsonb(OLD)-'archived_at') THEN
    RAISE EXCEPTION 'Source provenance is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brand_source_immutable ON brand_source;
CREATE TRIGGER brand_source_immutable BEFORE UPDATE OR DELETE ON brand_source FOR EACH ROW EXECUTE FUNCTION immutable_brand_source();
