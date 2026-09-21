CREATE TABLE IF NOT EXISTS brand_research_material (
  owner_id text NOT NULL,
  run_id uuid NOT NULL,
  material_id uuid NOT NULL REFERENCES brand_material(id),
  material_version integer NOT NULL CHECK(material_version > 0),
  original_hash text NOT NULL CHECK(original_hash ~ '^[0-9a-f]{64}$'),
  derivative_hash text NOT NULL CHECK(derivative_hash ~ '^[0-9a-f]{64}$'),
  role text NOT NULL CHECK(role IN ('original','reference')),
  observation jsonb NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,run_id,material_id),
  FOREIGN KEY(owner_id,run_id) REFERENCES brand_research_run(owner_id,id),
  CHECK(octet_length(observation::text) <= 4096)
);
CREATE INDEX IF NOT EXISTS brand_research_material_run_idx ON brand_research_material(owner_id,run_id,created_at,material_id);
DROP TRIGGER IF EXISTS brand_research_material_immutable ON brand_research_material;
CREATE TRIGGER brand_research_material_immutable BEFORE UPDATE OR DELETE ON brand_research_material FOR EACH ROW EXECUTE FUNCTION immutable_brand_research_v1();
