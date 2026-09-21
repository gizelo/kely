CREATE TABLE IF NOT EXISTS brand_research_run (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  command_key text NOT NULL,
  input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
  input jsonb NOT NULL,
  supersedes_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,command_key),
  FOREIGN KEY(owner_id,supersedes_run_id) REFERENCES brand_research_run(owner_id,id),
  CHECK(length(command_key) BETWEEN 8 AND 100),
  CHECK(octet_length(input::text) <= 32768),
  CHECK(supersedes_run_id IS NULL OR supersedes_run_id <> id)
);
CREATE INDEX IF NOT EXISTS brand_research_run_owner_idx ON brand_research_run(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS brand_research_event (
  sequence bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  owner_id text NOT NULL,
  run_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','resolving','fetching','extracting','strategizing','checking','review_ready','needs_input','partial','failed','uncertain')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,run_id) REFERENCES brand_research_run(owner_id,id),
  CHECK(octet_length(detail::text) <= 8192)
);
CREATE INDEX IF NOT EXISTS brand_research_event_run_idx ON brand_research_event(owner_id,run_id,sequence DESC);

CREATE TABLE IF NOT EXISTS brand_research_source (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  run_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('website','social','directory','user','upload')),
  source_role text NOT NULL DEFAULT 'official' CHECK(source_role IN ('official','external_context','user_provided')),
  source_url text NOT NULL,
  excerpt text NOT NULL CHECK(length(excerpt) BETWEEN 1 AND 500),
  excerpt_start integer NOT NULL DEFAULT 0 CHECK(excerpt_start >= 0),
  excerpt_end integer NOT NULL CHECK(excerpt_end > excerpt_start),
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('complete','partial','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,run_id) REFERENCES brand_research_run(owner_id,id)
);
CREATE INDEX IF NOT EXISTS brand_research_source_run_idx ON brand_research_source(owner_id,run_id,created_at,id);

CREATE TABLE IF NOT EXISTS brand_research_snapshot (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  run_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL,
  supersedes_snapshot_id uuid,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,id),
  UNIQUE(owner_id,run_id,version),
  UNIQUE(owner_id,run_id,id),
  FOREIGN KEY(owner_id,run_id) REFERENCES brand_research_run(owner_id,id),
  FOREIGN KEY(owner_id,run_id,supersedes_snapshot_id) REFERENCES brand_research_snapshot(owner_id,run_id,id),
  CHECK(octet_length(snapshot::text) <= 131072),
  CHECK(supersedes_snapshot_id IS NULL OR supersedes_snapshot_id <> id)
);
CREATE INDEX IF NOT EXISTS brand_research_snapshot_run_idx ON brand_research_snapshot(owner_id,run_id,version DESC);

CREATE OR REPLACE FUNCTION immutable_brand_research_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Brand research records are append-only'; END $$;
DROP TRIGGER IF EXISTS brand_research_run_immutable ON brand_research_run;
CREATE TRIGGER brand_research_run_immutable BEFORE UPDATE OR DELETE ON brand_research_run FOR EACH ROW EXECUTE FUNCTION immutable_brand_research_v1();
DROP TRIGGER IF EXISTS brand_research_event_immutable ON brand_research_event;
CREATE TRIGGER brand_research_event_immutable BEFORE UPDATE OR DELETE ON brand_research_event FOR EACH ROW EXECUTE FUNCTION immutable_brand_research_v1();
DROP TRIGGER IF EXISTS brand_research_source_immutable ON brand_research_source;
CREATE TRIGGER brand_research_source_immutable BEFORE UPDATE OR DELETE ON brand_research_source FOR EACH ROW EXECUTE FUNCTION immutable_brand_research_v1();
DROP TRIGGER IF EXISTS brand_research_snapshot_immutable ON brand_research_snapshot;
CREATE TRIGGER brand_research_snapshot_immutable BEFORE UPDATE OR DELETE ON brand_research_snapshot FOR EACH ROW EXECUTE FUNCTION immutable_brand_research_v1();
