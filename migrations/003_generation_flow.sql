ALTER TABLE quote ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'fixture' CHECK(origin IN ('fixture','ai_preview','openai'));
ALTER TABLE quote ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'gpt-5.6-luna';
ALTER TABLE quote ADD COLUMN IF NOT EXISTS scope jsonb;
ALTER TABLE quote ADD COLUMN IF NOT EXISTS package_id uuid;
ALTER TABLE quote DROP CONSTRAINT IF EXISTS quote_credits_check;
ALTER TABLE quote ADD CONSTRAINT quote_credits_check CHECK(credits >= 0);
ALTER TABLE operation ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'fixture' CHECK(origin IN ('fixture','ai_preview','openai'));
ALTER TABLE operation ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'gpt-5.6-luna';
ALTER TABLE operation ADD COLUMN IF NOT EXISTS scope jsonb;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS package_id uuid;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS cost jsonb;
CREATE TABLE IF NOT EXISTS preparation_package (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), publication_id uuid NOT NULL REFERENCES publication(id),
  origin text NOT NULL CHECK(origin IN ('ai_preview','openai')), model text NOT NULL,
  activated boolean NOT NULL DEFAULT false, replies_used integer NOT NULL DEFAULT 0 CHECK(replies_used BETWEEN 0 AND 3),
  attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
  closed boolean NOT NULL DEFAULT false, paused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS preparation_owner_publication ON preparation_package(owner_id,publication_id,created_at DESC);
CREATE OR REPLACE FUNCTION kely_protect_operation_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.owner_id,NEW.publication_id,NEW.quote_id,NEW.request_key,NEW.kind,NEW.input_state,NEW.instruction,NEW.business_context,NEW.input_snapshot,NEW.input_hash,NEW.origin,NEW.model,NEW.scope,NEW.package_id)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.publication_id,OLD.quote_id,OLD.request_key,OLD.kind,OLD.input_state,OLD.instruction,OLD.business_context,OLD.input_snapshot,OLD.input_hash,OLD.origin,OLD.model,OLD.scope,OLD.package_id) THEN
    RAISE EXCEPTION 'Accepted operation inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$;
