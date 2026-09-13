CREATE TABLE IF NOT EXISTS brand_workspace (
  owner_id text PRIMARY KEY REFERENCES "user"(id),
  version integer NOT NULL DEFAULT 0 CHECK(version>=0),
  state jsonb NOT NULL DEFAULT '{"audience":"","palette":null,"headlines":"default"}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brand_event (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  base_version integer NOT NULL,
  resulting_version integer NOT NULL,
  field text NOT NULL CHECK(field IN ('audience','palette','headlines')),
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  undo_of uuid REFERENCES brand_event(id),
  command_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,command_key)
);
CREATE TABLE IF NOT EXISTS brand_material (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  role text NOT NULL CHECK(role IN ('reference','original')),
  kind text NOT NULL CHECK(kind IN ('image','link')),
  label text NOT NULL,
  source_url text,
  stored_name text,
  mime text,
  bytes integer NOT NULL DEFAULT 0,
  width integer,
  height integer,
  content_hash text,
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_material_owner ON brand_material(owner_id);
CREATE INDEX IF NOT EXISTS brand_event_owner ON brand_event(owner_id,resulting_version);
CREATE OR REPLACE FUNCTION immutable_brand_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Brand events are append-only'; END $$;
DROP TRIGGER IF EXISTS brand_event_immutable ON brand_event;
CREATE TRIGGER brand_event_immutable BEFORE UPDATE OR DELETE ON brand_event FOR EACH ROW EXECUTE FUNCTION immutable_brand_event();
CREATE OR REPLACE FUNCTION immutable_brand_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'archived_at') IS DISTINCT FROM (to_jsonb(OLD)-'archived_at') THEN
    RAISE EXCEPTION 'Material bytes and provenance are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brand_material_immutable ON brand_material;
CREATE TRIGGER brand_material_immutable BEFORE UPDATE OR DELETE ON brand_material FOR EACH ROW EXECUTE FUNCTION immutable_brand_material();
