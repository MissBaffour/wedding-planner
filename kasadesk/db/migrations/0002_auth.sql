-- KasaDesk — 0002_auth.sql : sessions remember the selected business; password resets.
BEGIN;

ALTER TABLE auth_sessions
  ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,          -- sha256 of the emailed token
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO kasadesk_app, kasadesk_system;

-- Signup needs to know whether a phone is already used, but RLS hides other users.
-- Returns only a boolean, never the account.
CREATE FUNCTION phone_taken(p_phone text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE phone_e164 = p_phone)
$$;
REVOKE ALL ON FUNCTION phone_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION phone_taken(text) TO kasadesk_app;

INSERT INTO schema_migrations (version) VALUES ('0002_auth');
COMMIT;
