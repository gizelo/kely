CREATE OR REPLACE FUNCTION protect_kely_public_signup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total_accounts integer;
  recent_accounts integer;
BEGIN
  PERFORM pg_advisory_xact_lock(6381044);

  IF EXISTS (
    SELECT 1
    FROM beta_access_token
    WHERE purpose = 'invite'
      AND email = lower(NEW.email)
      AND used_at IS NULL
      AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'reserved invite email' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE created_at > now() - interval '24 hours')::integer
  INTO total_accounts, recent_accounts
  FROM "user";

  IF total_accounts >= 500 OR recent_accounts >= 50 THEN
    RAISE EXCEPTION 'public signup capacity reached' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_kely_public_signup_trigger ON "user";
CREATE TRIGGER protect_kely_public_signup_trigger
BEFORE INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION protect_kely_public_signup();
