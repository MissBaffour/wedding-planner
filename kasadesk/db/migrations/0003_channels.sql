-- KasaDesk — 0003_channels.sql : WhatsApp + web chat plumbing.
BEGIN;

-- Bring-your-own-app WhatsApp channels and web chat get a public, unguessable routing key.
ALTER TABLE channels ADD COLUMN webhook_key text UNIQUE;

-- The gateway receives webhooks before it knows the tenant.
ALTER TABLE webhook_events ADD COLUMN channel_id uuid;

-- Dispatcher lease: a message stuck in 'sending' (worker crashed) can be re-claimed after a timeout.
ALTER TABLE messages ADD COLUMN claimed_at timestamptz;
CREATE INDEX messages_stuck_idx ON messages (claimed_at) WHERE status IN ('queued', 'sending');

-- 24-hour window lookup: latest inbound per contact per channel.
CREATE INDEX messages_last_inbound_idx ON messages (business_id, contact_id, channel_id, created_at DESC)
  WHERE direction = 'inbound';

-- Outbox relay scans unpublished rows in order.
CREATE INDEX outbox_unpublished_created ON outbox (created_at) WHERE published_at IS NULL;

-- Pre-tenant lookup for bring-your-own-app webhooks: key -> channel incl. ENCRYPTED credentials
-- (needed to verify the per-channel signature). Decryption needs the app's key, which the DB never has.
CREATE FUNCTION resolve_channel_by_webhook_key(p_key text)
RETURNS TABLE (business_id uuid, channel_id uuid, type channel_type, status channel_status,
               external_id text, credentials_enc bytea, credentials_key_id text, config jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.business_id, c.id, c.type, c.status, c.external_id, c.credentials_enc, c.credentials_key_id, c.config
    FROM channels c WHERE c.webhook_key = p_key
$$;
REVOKE ALL ON FUNCTION resolve_channel_by_webhook_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_channel_by_webhook_key(text) TO kasadesk_app, kasadesk_system;

-- resolve_channel() from 0001 only returns ids; the gateway also needs the connection mode.
CREATE FUNCTION resolve_channel_mode(p_type channel_type, p_external_id text)
RETURNS TABLE (business_id uuid, channel_id uuid, status channel_status, mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.business_id, c.id, c.status, c.config->>'mode'
    FROM channels c WHERE c.type = p_type AND c.external_id = p_external_id
$$;
REVOKE ALL ON FUNCTION resolve_channel_mode(channel_type, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_channel_mode(channel_type, text) TO kasadesk_app, kasadesk_system;

INSERT INTO schema_migrations (version) VALUES ('0003_channels');
COMMIT;
