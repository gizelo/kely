ALTER TABLE quote ADD COLUMN IF NOT EXISTS input_snapshot jsonb;
ALTER TABLE quote ADD COLUMN IF NOT EXISTS input_hash text;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS input_snapshot jsonb;
ALTER TABLE operation ADD COLUMN IF NOT EXISTS input_hash text;

CREATE OR REPLACE FUNCTION kely_protect_quote_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'accepted_operation_id') IS DISTINCT FROM (to_jsonb(OLD) - 'accepted_operation_id') THEN
    RAISE EXCEPTION 'Quoted inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS quote_input_immutable ON quote;
CREATE TRIGGER quote_input_immutable BEFORE UPDATE ON quote FOR EACH ROW EXECUTE FUNCTION kely_protect_quote_input();

CREATE OR REPLACE FUNCTION kely_protect_operation_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.owner_id,NEW.publication_id,NEW.quote_id,NEW.request_key,NEW.kind,NEW.input_state,NEW.instruction,NEW.business_context,NEW.input_snapshot,NEW.input_hash)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.publication_id,OLD.quote_id,OLD.request_key,OLD.kind,OLD.input_state,OLD.instruction,OLD.business_context,OLD.input_snapshot,OLD.input_hash) THEN
    RAISE EXCEPTION 'Accepted operation inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS operation_input_immutable ON operation;
CREATE TRIGGER operation_input_immutable BEFORE UPDATE ON operation FOR EACH ROW EXECUTE FUNCTION kely_protect_operation_input();
