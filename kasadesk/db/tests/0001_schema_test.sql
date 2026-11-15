-- KasaDesk schema tests. Run via db/scripts/verify.sh (creates a throwaway DB).
-- Every test runs as kasadesk_app, the same role the API and worker use,
-- so RLS is actually exercised. Any failed ASSERT aborts with a non-zero exit.
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
SET ROLE kasadesk_app;

-- Fixed ids for readability
--   Tenant A: aaaaaaaa-...   Tenant B: bbbbbbbb-...
-- ---------------------------------------------------------------------
-- Fixtures: signup flow for two tenants (user + business + owner membership)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('app.user_id',     'a0000000-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO users (id, email, password_hash, full_name)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ama@shopa.gh', 'x', 'Ama Owner');
  INSERT INTO businesses (id, name, slug, plan_code)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'Shop A', 'shop-a', 'starter');
  INSERT INTO business_settings (business_id) VALUES ('aaaaaaaa-0000-0000-0000-000000000000');
  INSERT INTO memberships (id, business_id, user_id, role)
    VALUES ('a1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000',
            'a0000000-0000-0000-0000-000000000001', 'owner');
  INSERT INTO channels (id, business_id, type, name, external_id, status)
    VALUES ('ac000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000',
            'whatsapp', 'Shop A WhatsApp', 'PNID-A', 'active');
  INSERT INTO contacts (id, business_id, display_name, phone_e164)
    VALUES ('ad000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', 'Kofi', '+233241234567');
  INSERT INTO conversations (id, business_id, contact_id, channel_id)
    VALUES ('ae000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000',
            'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001');
  INSERT INTO messages (business_id, conversation_id, contact_id, channel_id, direction, sender_type, body, provider_message_id, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'ae000000-0000-0000-0000-000000000001',
            'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001',
            'inbound', 'contact', 'Ete sen? How much be the phone?', 'wamid.A1', 'received');
END $$;

DO $$
BEGIN
  PERFORM set_config('app.user_id',     'b0000000-0000-0000-0000-000000000001', true);
  PERFORM set_config('app.business_id', 'bbbbbbbb-0000-0000-0000-000000000000', true);
  INSERT INTO users (id, email, password_hash, full_name)
    VALUES ('b0000000-0000-0000-0000-000000000001', 'yaw@shopb.gh', 'x', 'Yaw Owner');
  INSERT INTO businesses (id, name, slug) VALUES ('bbbbbbbb-0000-0000-0000-000000000000', 'Shop B', 'shop-b');
  INSERT INTO memberships (business_id, user_id, role)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000001', 'owner');
  INSERT INTO channels (id, business_id, type, name, external_id, status)
    VALUES ('bc000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000000',
            'whatsapp', 'Shop B WhatsApp', 'PNID-B', 'active');
  -- Same customer phone as in tenant A: allowed, tenants are independent.
  INSERT INTO contacts (id, business_id, phone_e164)
    VALUES ('bd000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000000', '+233241234567');
  INSERT INTO conversations (id, business_id, contact_id, channel_id)
    VALUES ('be000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000000',
            'bd000000-0000-0000-0000-000000000001', 'bc000000-0000-0000-0000-000000000001');
END $$;
\echo 'ok   fixtures: two tenants created through RLS'

-- ---------------------------------------------------------------------
-- 1. Tenant isolation
-- ---------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  SELECT count(*) INTO n FROM conversations;  ASSERT n = 1, 'A should see exactly its 1 conversation';
  SELECT count(*) INTO n FROM businesses;     ASSERT n = 1, 'A should see only its own business';
  SELECT count(*) INTO n FROM contacts WHERE id = 'bd000000-0000-0000-0000-000000000001';
  ASSERT n = 0, 'A must not see B''s contact by id';
  UPDATE conversations SET priority = 3 WHERE id = 'be000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;  ASSERT n = 0, 'A must not update B''s conversation';
  SELECT count(*) INTO n FROM users;          ASSERT n = 1, 'A should see only its member users';
END $$;
\echo 'ok   1a tenant A cannot read or update tenant B rows'

DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.business_id', '', true);
  PERFORM set_config('app.user_id', '', true);
  SELECT count(*) INTO n FROM messages;  ASSERT n = 0, 'no tenant context must mean no rows';
  SELECT count(*) INTO n FROM users;     ASSERT n = 0, 'no context must hide users';
END $$;
\echo 'ok   1b no tenant context => no rows (fail closed)'

DO $$
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO tags (business_id, name) VALUES ('bbbbbbbb-0000-0000-0000-000000000000', 'vip');
  RAISE EXCEPTION 'expected RLS violation';
EXCEPTION WHEN insufficient_privilege THEN NULL;  -- 42501 new row violates row-level security policy
END $$;
\echo 'ok   1c cannot insert a row tagged with another tenant''s business_id'

DO $$
BEGIN
  -- Even with matching business_id, composite FK blocks pointing at B's conversation.
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO messages (business_id, conversation_id, contact_id, channel_id, direction, sender_type, body, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'be000000-0000-0000-0000-000000000001',
            'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001',
            'inbound', 'contact', 'x', 'received');
  RAISE EXCEPTION 'expected FK violation';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END $$;
\echo 'ok   1d composite FKs block cross-tenant references'

-- ---------------------------------------------------------------------
-- 2. Idempotency
-- ---------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO messages (business_id, conversation_id, contact_id, channel_id, direction, sender_type, body, provider_message_id, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'ae000000-0000-0000-0000-000000000001',
            'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001',
            'inbound', 'contact', 'duplicate webhook delivery', 'wamid.A1', 'received')
    ON CONFLICT (channel_id, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'replayed provider message must be a no-op';
END $$;
\echo 'ok   2a inbound message stored once per provider message id'

DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  FOR i IN 1..2 LOOP
    INSERT INTO messages (business_id, conversation_id, contact_id, channel_id, direction, sender_type, sender_id, body, client_id, status)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'ae000000-0000-0000-0000-000000000001',
              'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001',
              'outbound', 'agent', 'a1000000-0000-0000-0000-000000000001', 'GH₵ 2,500. Ready today.',
              'cccccccc-0000-0000-0000-000000000001', 'queued')
      ON CONFLICT (business_id, client_id) WHERE client_id IS NOT NULL DO NOTHING;
  END LOOP;
  SELECT count(*) INTO n FROM messages WHERE client_id = 'cccccccc-0000-0000-0000-000000000001';
  ASSERT n = 1, 'PWA retry with same client_id must not double-send';
END $$;
\echo 'ok   2b outbound send idempotent on client_id (offline retries)'

DO $$
DECLARE n int;
BEGIN
  INSERT INTO webhook_events (provider, dedupe_key, signature_valid, payload)
    VALUES ('meta', 'sha256:abc', true, '{}') ON CONFLICT DO NOTHING;
  INSERT INTO webhook_events (provider, dedupe_key, signature_valid, payload)
    VALUES ('meta', 'sha256:abc', true, '{}') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'duplicate webhook body must be ignored';
END $$;
\echo 'ok   2c webhook gateway dedupes on (provider, dedupe_key)'

DO $$
BEGIN
  PERFORM count(*) FROM webhook_events;
  RAISE EXCEPTION 'app role must not read webhook_events';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
\echo 'ok   2d app role can only INSERT raw webhooks (worker reads via system role)'

-- ---------------------------------------------------------------------
-- 3. Conversations
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO conversations (business_id, contact_id, channel_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'expected unique violation';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
\echo 'ok   3a only one open conversation per contact per channel'

DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  UPDATE conversations SET status = 'resolved', resolved_at = now() WHERE id = 'ae000000-0000-0000-0000-000000000001';
  INSERT INTO conversations (business_id, contact_id, channel_id)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO n FROM conversations WHERE contact_id = 'ad000000-0000-0000-0000-000000000001';
  ASSERT n = 2, 'new conversation allowed after resolve';
END $$;
\echo 'ok   3b new conversation allowed once the previous one is resolved'

-- ---------------------------------------------------------------------
-- 4. Plan enforcement: seat limit (Starter = 3)
-- ---------------------------------------------------------------------
DO $$
DECLARE i int;
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  FOR i IN 2..4 LOOP
    PERFORM set_config('app.user_id', format('a0000000-0000-0000-0000-00000000000%s', i), true);
    INSERT INTO users (id, email, password_hash, full_name)
      VALUES (format('a0000000-0000-0000-0000-00000000000%s', i)::uuid, format('agent%s@shopa.gh', i), 'x', 'Agent');
  END LOOP;
  INSERT INTO memberships (business_id, user_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000002'),
    ('aaaaaaaa-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000003');
  BEGIN
    INSERT INTO memberships (business_id, user_id)
      VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000004');
    RAISE EXCEPTION 'expected seat limit';
  EXCEPTION WHEN SQLSTATE 'KD001' THEN NULL;
  END;
  -- A disabled/invited member does not consume a seat
  INSERT INTO memberships (business_id, user_id, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000004', 'invited');
  BEGIN
    UPDATE memberships SET status = 'active' WHERE user_id = 'a0000000-0000-0000-0000-000000000004';
    RAISE EXCEPTION 'expected seat limit on activation';
  EXCEPTION WHEN SQLSTATE 'KD001' THEN NULL;
  END;
END $$;
\echo 'ok   4a Starter plan blocks a 4th active seat (insert and activation)'

DO $$
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO memberships (business_id, user_id, role, status)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000001', 'owner', 'disabled');
  RAISE EXCEPTION 'expected unique violation';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
\echo 'ok   4b exactly one owner per business'

-- ---------------------------------------------------------------------
-- 5. Compliance
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO audit_logs (business_id, actor_type, action) VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'system', 'test.event');
  UPDATE audit_logs SET action = 'tampered';
  RAISE EXCEPTION 'expected audit log to be immutable';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
\echo 'ok   5a audit log is append-only'

DO $$
DECLARE n int; c uuid;
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO merchant_payment_accounts (id, business_id, provider, credentials_enc, credentials_key_id)
    VALUES ('af000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', 'paystack', '\x00', 'k1');
  INSERT INTO payment_requests (id, business_id, account_id, conversation_id, contact_id, amount_minor, description, provider, idempotency_key, expires_at, status, paid_at)
    VALUES ('a9000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000000', 'af000000-0000-0000-0000-000000000001',
            'ae000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
            250000, 'Tecno phone', 'paystack', 'pr-1', now() + interval '1 hour', 'success', now());
  INSERT INTO sales (business_id, conversation_id, contact_id, payment_request_id, amount_minor, source)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'ae000000-0000-0000-0000-000000000001',
            'ad000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001', 250000, 'payment_request');
  -- Right to erasure: delete the contact
  DELETE FROM contacts WHERE id = 'ad000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO n FROM messages WHERE contact_id = 'ad000000-0000-0000-0000-000000000001';
  ASSERT n = 0, 'messages must be erased with the contact';
  SELECT contact_id INTO c FROM sales WHERE payment_request_id = 'a9000000-0000-0000-0000-000000000001';
  ASSERT c IS NULL, 'sale must survive erasure, unlinked from the person';
  SELECT count(*) INTO n FROM payment_requests WHERE contact_id IS NULL AND business_id = 'aaaaaaaa-0000-0000-0000-000000000000';
  ASSERT n = 1, 'payment record kept for bookkeeping, unlinked';
END $$;
\echo 'ok   5b contact erasure deletes messages, keeps anonymised financial records'

-- ---------------------------------------------------------------------
-- 6. Validation
-- ---------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('app.business_id', 'aaaaaaaa-0000-0000-0000-000000000000', true);
  INSERT INTO contacts (business_id, ghana_post_gps) VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'GA-492-7465');
  BEGIN
    INSERT INTO contacts (business_id, ghana_post_gps) VALUES ('aaaaaaaa-0000-0000-0000-000000000000', 'near the big tree');
    RAISE EXCEPTION 'expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO contacts (business_id, phone_e164) VALUES ('aaaaaaaa-0000-0000-0000-000000000000', '0241234567');
    RAISE EXCEPTION 'expected check violation';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
\echo 'ok   6a GPS code and E.164 phone format enforced'

-- ---------------------------------------------------------------------
-- 7. Pre-tenant lookups
-- ---------------------------------------------------------------------
DO $$
DECLARE b uuid; n int;
BEGIN
  PERFORM set_config('app.business_id', '', true);
  SELECT business_id INTO b FROM resolve_channel('whatsapp', 'PNID-B');
  ASSERT b = 'bbbbbbbb-0000-0000-0000-000000000000', 'webhook routing must find tenant B';
  SELECT count(*) INTO n FROM auth_lookup_user('AMA@shopa.gh');
  ASSERT n = 1, 'login lookup is case-insensitive';
  SELECT count(*) INTO n FROM auth_user_businesses('a0000000-0000-0000-0000-000000000001');
  ASSERT n = 1, 'business switcher lists memberships';
END $$;
\echo 'ok   7a webhook routing and auth lookups work without tenant context'

\echo 'ALL SCHEMA TESTS PASSED'
