-- =====================================================================
-- KasaDesk — 0001_init.sql
-- Target: PostgreSQL 16+. Run as kasadesk_migrator (object owner).
--
-- Conventions
--   * Every tenant table has business_id uuid NOT NULL and an RLS policy
--     `business_id = app_business_id()`. The API/worker set the tenant with
--     `SET LOCAL app.business_id = '<uuid>'` at the start of each transaction.
--   * Child rows reference parents with COMPOSITE foreign keys
--     (business_id, parent_id) so a row can never point at another tenant's row.
--   * IDs are uuid. The app generates UUIDv7 (time-ordered); the DB default
--     gen_random_uuid() is only a fallback.
--   * Money is stored as integer minor units (pesewas for GHS) + currency.
--   * Phones are E.164 (+233XXXXXXXXX). Timestamps are timestamptz (UTC);
--     business-local logic uses businesses.timezone (default Africa/Accra).
--   * Tables are owned by kasadesk_migrator and RLS is ENABLED (not FORCED):
--     the owner bypasses RLS so the few SECURITY DEFINER lookups below work;
--     the app connects as kasadesk_app, which does not own tables and has
--     NOBYPASSRLS, so RLS always applies to it.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Tenant / user context helpers
-- ---------------------------------------------------------------------
CREATE FUNCTION app_business_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.business_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE subscription_status AS ENUM
  ('trialing','active','past_due','read_only','paused','cancelled');
CREATE TYPE member_role        AS ENUM ('owner','admin','agent');
CREATE TYPE member_status      AS ENUM ('invited','active','disabled');
CREATE TYPE agent_presence     AS ENUM ('online','away','offline');
CREATE TYPE channel_type       AS ENUM ('whatsapp','instagram','messenger','sms','email','webchat');
CREATE TYPE channel_status     AS ENUM ('pending','active','error','disconnected');
CREATE TYPE conversation_status AS ENUM ('open','pending','snoozed','resolved');
CREATE TYPE message_direction  AS ENUM ('inbound','outbound');
CREATE TYPE sender_type        AS ENUM ('contact','agent','bot','system');
CREATE TYPE message_kind       AS ENUM
  ('text','image','audio','video','document','sticker','location','contact_card',
   'template','interactive','reaction','payment_request','unsupported');
CREATE TYPE message_status     AS ENUM
  ('received','queued','sending','sent','delivered','read','failed');
CREATE TYPE routing_strategy   AS ENUM ('round_robin','least_busy','skill_based');
CREATE TYPE payment_method     AS ENUM ('mtn_momo','telecel_cash','airteltigo_money','card');
CREATE TYPE payment_status     AS ENUM ('pending','success','failed','expired','cancelled','refunded');
CREATE TYPE invoice_status     AS ENUM ('draft','open','paid','void','uncollectible');
CREATE TYPE consent_status     AS ENUM ('unknown','granted','withdrawn');
CREATE TYPE data_request_type  AS ENUM ('export','delete');
CREATE TYPE data_request_status AS ENUM ('pending','processing','completed','failed','rejected');

-- ---------------------------------------------------------------------
-- Plans (global catalogue, not tenant data)
-- ---------------------------------------------------------------------
CREATE TABLE plans (
  code           text PRIMARY KEY,
  name           text NOT NULL,
  price_minor    bigint NOT NULL CHECK (price_minor >= 0),   -- pesewas / month
  currency       char(3) NOT NULL DEFAULT 'GHS',
  max_agents     int NOT NULL CHECK (max_agents > 0),
  features       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     int NOT NULL DEFAULT 0
);

INSERT INTO plans (code, name, price_minor, max_agents, sort_order, features) VALUES
  ('starter',  'Starter',  14900,  3, 1, '{"automation_rules": 10,  "skill_routing": false, "api_access": false}'),
  ('growth',   'Growth',   34900,  8, 2, '{"automation_rules": 50,  "skill_routing": true,  "api_access": false}'),
  ('business', 'Business', 79900, 20, 3, '{"automation_rules": 500, "skill_routing": true,  "api_access": true}');

-- ---------------------------------------------------------------------
-- Businesses (the tenant) + settings
-- ---------------------------------------------------------------------
CREATE TABLE businesses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  slug                  citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  phone_e164            text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email                 citext,
  country               char(2) NOT NULL DEFAULT 'GH',
  timezone              text NOT NULL DEFAULT 'Africa/Accra',
  plan_code             text NOT NULL DEFAULT 'growth' REFERENCES plans(code),
  subscription_status   subscription_status NOT NULL DEFAULT 'trialing',
  trial_started_at      timestamptz NOT NULL DEFAULT now(),
  trial_ends_at         timestamptz NOT NULL DEFAULT now() + interval '14 days',
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  grace_ends_at         timestamptz,          -- set when a paid period lapses (+3 days)
  read_only_ends_at     timestamptz,          -- set on entering read_only (+7 days)
  paused_at             timestamptz,
  billing_msisdn        text CHECK (billing_msisdn ~ '^\+[1-9][0-9]{7,14}$'),
  billing_email         citext,
  data_retention_days   int NOT NULL DEFAULT 730 CHECK (data_retention_days BETWEEN 30 AND 3650),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_status_idx ON businesses (subscription_status, trial_ends_at, current_period_end);
CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_settings (
  business_id                  uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  routing_strategy             routing_strategy NOT NULL DEFAULT 'round_robin',
  sla_first_response_seconds   int NOT NULL DEFAULT 300 CHECK (sla_first_response_seconds > 0),  -- escalation level 1
  sla_escalation_seconds       int NOT NULL DEFAULT 600 CHECK (sla_escalation_seconds > 0),      -- escalation level 2
  auto_reassign_on_offline     boolean NOT NULL DEFAULT true,
  offline_grace_seconds        int NOT NULL DEFAULT 120 CHECK (offline_grace_seconds >= 30),
  max_open_per_agent           int NOT NULL DEFAULT 15 CHECK (max_open_per_agent > 0),
  auto_greeting_enabled        boolean NOT NULL DEFAULT true,
  auto_greeting_text           text NOT NULL DEFAULT 'Hello! Thanks for reaching out. An agent will be with you shortly.',
  away_message_enabled         boolean NOT NULL DEFAULT true,
  away_message_text            text NOT NULL DEFAULT 'We are currently closed. We will reply when we open.',
  queue_position_enabled       boolean NOT NULL DEFAULT true,
  default_language             text NOT NULL DEFAULT 'en' CHECK (default_language IN ('en','tw','pcm')),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CHECK (sla_escalation_seconds > sla_first_response_seconds)
);
CREATE TRIGGER business_settings_updated_at BEFORE UPDATE ON business_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_hours (
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  opens_at     time NOT NULL,
  closes_at    time NOT NULL,
  PRIMARY KEY (business_id, weekday, opens_at),
  CHECK (closes_at > opens_at)
);

CREATE TABLE business_holidays (
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day          date NOT NULL,
  name         text NOT NULL,
  PRIMARY KEY (business_id, day)
);

-- ---------------------------------------------------------------------
-- Users (global identity) and memberships (per-business role/seat)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  phone_e164         text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  password_hash      text NOT NULL,                 -- argon2id
  full_name          text NOT NULL,
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  last_login_at      timestamptz,
  disabled_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              member_role NOT NULL DEFAULT 'agent',
  status            member_status NOT NULL DEFAULT 'active',
  display_name      text,
  skills            text[] NOT NULL DEFAULT '{}',         -- e.g. {'lang:tw','product:phones'}
  max_concurrent    int CHECK (max_concurrent > 0),       -- NULL = business default
  presence          agent_presence NOT NULL DEFAULT 'offline',  -- last known; live state is in Redis
  last_seen_at      timestamptz,
  last_assigned_at  timestamptz,                          -- round-robin cursor
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX memberships_one_owner ON memberships (business_id) WHERE role = 'owner';
CREATE INDEX memberships_routing_idx ON memberships (business_id, status, presence, last_assigned_at);
CREATE INDEX memberships_skills_idx ON memberships USING gin (skills);
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seat limit: active members (owner + admins + agents) <= plan.max_agents.
-- Enforced here as a backstop; the API checks first to return a friendly error.
CREATE FUNCTION enforce_seat_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_max   int;
  v_count int;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;
  -- serialize concurrent seat changes for this business
  PERFORM pg_advisory_xact_lock(hashtextextended('seats:' || NEW.business_id::text, 0));
  SELECT p.max_agents INTO v_max
    FROM businesses b JOIN plans p ON p.code = b.plan_code
   WHERE b.id = NEW.business_id;
  SELECT count(*) INTO v_count
    FROM memberships
   WHERE business_id = NEW.business_id AND status = 'active' AND id <> NEW.id;
  IF v_count + 1 > v_max THEN
    RAISE EXCEPTION 'seat limit reached (% of %)', v_count, v_max
      USING ERRCODE = 'KD001', HINT = 'upgrade_plan';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_seat_limit BEFORE INSERT OR UPDATE OF status ON memberships
  FOR EACH ROW EXECUTE FUNCTION enforce_seat_limit();

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         member_role NOT NULL DEFAULT 'agent' CHECK (role <> 'owner'),
  token_hash   bytea NOT NULL UNIQUE,      -- sha256 of the emailed token; raw token never stored
  invited_by   uuid NOT NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, invited_by) REFERENCES memberships(business_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX invitations_pending_email ON invitations (business_id, email) WHERE accepted_at IS NULL;

-- Refresh-token sessions (user-scoped, not tenant-scoped; only the auth module touches it).
CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,             -- rotation family; reuse of a rotated token revokes the family
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  rotated_at    timestamptz,
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Channels (one row per connected account: a WA number, an IG account,
-- an FB page, an SMS sender ID, an inbound email address, a web widget)
-- ---------------------------------------------------------------------
CREATE TABLE channels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type                  channel_type NOT NULL,
  name                  text NOT NULL,
  -- Provider identifier used to route inbound webhooks to the tenant:
  --   whatsapp: phone_number_id | instagram: IG professional account id
  --   messenger: page id | sms: provider:sender/short code | email: inbound address
  --   webchat: public widget key
  external_id           text NOT NULL,
  external_parent_id    text,             -- e.g. WhatsApp Business Account (WABA) id
  credentials_enc       bytea,            -- AES-256-GCM(iv||ciphertext||tag) of a JSON blob
  credentials_key_id    text,             -- which KEK version encrypted it (rotation)
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret settings
  status                channel_status NOT NULL DEFAULT 'pending',
  last_error            text,
  connected_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, external_id),
  UNIQUE (business_id, id),
  CHECK ((credentials_enc IS NULL) = (credentials_key_id IS NULL))
);
CREATE TRIGGER channels_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Contacts and their per-channel identities
-- ---------------------------------------------------------------------
CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  display_name        text,
  phone_e164          text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email               citext,
  preferred_language  text CHECK (preferred_language IN ('en','tw','pcm','other')),
  ghana_post_gps      text CHECK (ghana_post_gps ~ '^[A-Z]{2}-[0-9]{3,4}-[0-9]{3,4}$'),
  gps_lat             numeric(9,6),
  gps_lng             numeric(9,6),
  address_note        text,
  attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_status      consent_status NOT NULL DEFAULT 'unknown',   -- latest; history in contact_consent_events
  blocked             boolean NOT NULL DEFAULT false,
  merged_into_id      uuid,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, merged_into_id) REFERENCES contacts(business_id, id) ON DELETE SET NULL (merged_into_id)
);
-- Contact unification key #1: phone number (one live contact per phone per business)
CREATE UNIQUE INDEX contacts_phone_uniq ON contacts (business_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX contacts_email_idx ON contacts (business_id, email) WHERE email IS NOT NULL;
CREATE INDEX contacts_last_seen_idx ON contacts (business_id, last_seen_at DESC);
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Contact unification key #2: channel handle (wa_id, PSID, IGSID, email, widget visitor id).
-- PSIDs/IGSIDs are page/account-scoped, so uniqueness is per channel.
CREATE TABLE contact_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL,
  contact_id    uuid NOT NULL,
  channel_id    uuid NOT NULL,
  channel_type  channel_type NOT NULL,
  handle        text NOT NULL,
  profile       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- name / avatar as reported by the channel
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, channel_id, handle),
  FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, channel_id) REFERENCES channels(business_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_identities_contact_idx ON contact_identities (business_id, contact_id);

CREATE TABLE contact_consent_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL,
  contact_id   uuid NOT NULL,
  status       consent_status NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('service','marketing')),
  source       text NOT NULL,           -- 'webchat_form','whatsapp_optin','agent_recorded','keyword_stop',...
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_by  uuid,                    -- membership id; NULL = system
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_consent_events_idx ON contact_consent_events (business_id, contact_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------
CREATE TABLE conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL,
  contact_id            uuid NOT NULL,
  channel_id            uuid NOT NULL,
  status                conversation_status NOT NULL DEFAULT 'open',
  assignee_id           uuid,                    -- membership id
  priority              smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  subject               text,                    -- email subject
  language              text CHECK (language IN ('en','tw','pcm','other')),
  required_skill        text,                    -- for skill-based routing, e.g. 'lang:tw'
  queued_at             timestamptz,             -- entered the unassigned queue
  first_assigned_at     timestamptz,
  first_response_at     timestamptz,             -- first human agent reply
  sla_due_at            timestamptz,             -- next escalation deadline
  sla_level             smallint NOT NULL DEFAULT 0 CHECK (sla_level BETWEEN 0 AND 2),
  sla_breached          boolean NOT NULL DEFAULT false,
  last_inbound_at       timestamptz,             -- drives the WhatsApp/Meta 24-hour window
  last_outbound_at      timestamptz,
  last_message_at       timestamptz NOT NULL DEFAULT now(),
  last_message_preview  text,
  unread_count          int NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  snoozed_until         timestamptz,
  resolved_at           timestamptz,
  resolved_by           uuid,
  reopened_count        int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, contact_id)  REFERENCES contacts(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, channel_id)  REFERENCES channels(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, assignee_id) REFERENCES memberships(business_id, id) ON DELETE SET NULL (assignee_id),
  FOREIGN KEY (business_id, resolved_by) REFERENCES memberships(business_id, id) ON DELETE SET NULL (resolved_by),
  CHECK (status <> 'snoozed' OR snoozed_until IS NOT NULL)
);
-- One live conversation per contact per channel
CREATE UNIQUE INDEX conversations_one_open ON conversations (business_id, contact_id, channel_id)
  WHERE status <> 'resolved';
CREATE INDEX conversations_inbox_idx    ON conversations (business_id, status, last_message_at DESC);
CREATE INDEX conversations_assignee_idx ON conversations (business_id, assignee_id, status, last_message_at DESC);
CREATE INDEX conversations_queue_idx    ON conversations (business_id, queued_at)
  WHERE assignee_id IS NULL AND status = 'open';
CREATE INDEX conversations_sla_idx      ON conversations (sla_due_at)
  WHERE sla_due_at IS NOT NULL AND status IN ('open','pending');
CREATE INDEX conversations_contact_idx  ON conversations (business_id, contact_id, created_at DESC);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Messages — the normalized cross-channel schema
-- ---------------------------------------------------------------------
CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid NOT NULL,
  conversation_id      uuid NOT NULL,
  contact_id           uuid NOT NULL,          -- denormalized for cross-channel customer history
  channel_id           uuid NOT NULL,
  direction            message_direction NOT NULL,
  sender_type          sender_type NOT NULL,
  sender_id            uuid,                   -- membership id when sender_type = 'agent'
  kind                 message_kind NOT NULL DEFAULT 'text',
  body                 text,                   -- plain-text rendering (searchable)
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- normalized structured content
  provider_message_id  text,                   -- wamid / mid / SMS id / Message-ID
  client_id            uuid,                   -- PWA-generated id: makes offline re-sends idempotent
  reply_to_id          uuid,
  status               message_status NOT NULL,
  error_code           text,
  error_message        text,
  attempts             smallint NOT NULL DEFAULT 0,
  language             text CHECK (language IN ('en','tw','pcm','other')),
  transcript           text,                   -- voice-note transcription
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  failed_at            timestamptz,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, contact_id)      REFERENCES contacts(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, channel_id)      REFERENCES channels(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, sender_id)       REFERENCES memberships(business_id, id) ON DELETE SET NULL (sender_id),
  CHECK (sender_type <> 'agent' OR direction = 'outbound'),
  CHECK (direction = 'outbound' OR sender_type = 'contact')
);
-- Inbound idempotency: the same provider message is stored once, however many times the webhook retries.
CREATE UNIQUE INDEX messages_provider_uniq ON messages (channel_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- Outbound idempotency: the PWA can safely retry a send after a dropped connection.
CREATE UNIQUE INDEX messages_client_uniq ON messages (business_id, client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages (business_id, conversation_id, created_at);
CREATE INDEX messages_contact_idx      ON messages (business_id, contact_id, created_at DESC);
CREATE INDEX messages_retention_idx    ON messages (business_id, created_at);

CREATE TABLE message_attachments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL,
  message_id         uuid NOT NULL,
  mime_type          text NOT NULL,
  size_bytes         bigint CHECK (size_bytes >= 0),
  filename           text,
  storage_key        text,                 -- object-storage key once downloaded
  provider_media_id  text,                 -- e.g. WhatsApp media id (URLs expire; we re-download)
  sha256             bytea,
  duration_ms        int,
  width              int,
  height             int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, message_id) REFERENCES messages(business_id, id) ON DELETE CASCADE
);
CREATE INDEX message_attachments_msg_idx ON message_attachments (business_id, message_id);

CREATE TABLE conversation_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  author_id        uuid,
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  mentions         uuid[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, author_id)       REFERENCES memberships(business_id, id) ON DELETE SET NULL (author_id)
);
CREATE INDEX conversation_notes_idx ON conversation_notes (business_id, conversation_id, created_at);
CREATE TRIGGER conversation_notes_updated_at BEFORE UPDATE ON conversation_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Timeline of state changes: source of truth for analytics (assignments, escalations, resolves).
CREATE TABLE conversation_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  type             text NOT NULL CHECK (type IN (
                     'created','queued','assigned','unassigned','reassigned_offline','transferred',
                     'escalated','sla_breached','first_response','resolved','reopened','snoozed',
                     'tagged','untagged','payment_requested','payment_received','sale_recorded')),
  actor_type       sender_type NOT NULL DEFAULT 'system',
  actor_id         uuid,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_events_conv_idx ON conversation_events (business_id, conversation_id, created_at);
CREATE INDEX conversation_events_type_idx ON conversation_events (business_id, type, created_at);

-- ---------------------------------------------------------------------
-- Tags and canned responses
-- ---------------------------------------------------------------------
CREATE TABLE tags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         citext NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color        text NOT NULL DEFAULT '#64748b' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name),
  UNIQUE (business_id, id)
);

CREATE TABLE conversation_tags (
  business_id      uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  tag_id           uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, conversation_id, tag_id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, tag_id)          REFERENCES tags(business_id, id) ON DELETE CASCADE
);

CREATE TABLE contact_tags (
  business_id  uuid NOT NULL,
  contact_id   uuid NOT NULL,
  tag_id       uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, contact_id, tag_id),
  FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, tag_id)     REFERENCES tags(business_id, id) ON DELETE CASCADE
);

CREATE TABLE canned_responses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shortcut     citext NOT NULL CHECK (shortcut ~ '^[a-z0-9_-]{1,32}$'),
  title        text NOT NULL,
  body         text NOT NULL,
  language     text NOT NULL DEFAULT 'en' CHECK (language IN ('en','tw','pcm')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, shortcut, language)
);
CREATE TRIGGER canned_responses_updated_at BEFORE UPDATE ON canned_responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Automation
-- ---------------------------------------------------------------------
CREATE TABLE automation_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN (
                     'message_received','conversation_created','outside_business_hours',
                     'sla_breached','agent_offline','payment_received','conversation_resolved')),
  conditions       jsonb NOT NULL DEFAULT '{"all": []}'::jsonb,   -- validated by zod in app
  actions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  channel_types    channel_type[],                                -- NULL = all channels
  priority         int NOT NULL DEFAULT 100,                      -- lower runs first
  stop_processing  boolean NOT NULL DEFAULT false,
  enabled          boolean NOT NULL DEFAULT true,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX automation_rules_lookup ON automation_rules (business_id, trigger, priority) WHERE enabled;
CREATE TRIGGER automation_rules_updated_at BEFORE UPDATE ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One run per (rule, triggering event): makes the engine idempotent under job retries.
CREATE TABLE automation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL,
  rule_id          uuid NOT NULL,
  event_key        text NOT NULL,          -- e.g. 'msg:<message_id>' or 'sla:<conv_id>:1'
  conversation_id  uuid,
  status           text NOT NULL CHECK (status IN ('matched','skipped','succeeded','failed')),
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, rule_id, event_key),
  FOREIGN KEY (business_id, rule_id) REFERENCES automation_rules(business_id, id) ON DELETE CASCADE
);
CREATE INDEX automation_runs_created_idx ON automation_runs (business_id, created_at);

-- ---------------------------------------------------------------------
-- WhatsApp message templates (synced from Meta)
-- ---------------------------------------------------------------------
CREATE TABLE whatsapp_templates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL,
  channel_id            uuid NOT NULL,
  name                  text NOT NULL,
  language              text NOT NULL,                     -- Meta locale code, e.g. 'en', 'en_US'
  category              text NOT NULL CHECK (category IN ('marketing','utility','authentication')),
  status                text NOT NULL,                     -- as reported by Meta (APPROVED, PENDING, ...)
  components            jsonb NOT NULL,
  provider_template_id  text,
  rejected_reason       text,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, name, language),
  FOREIGN KEY (business_id, channel_id) REFERENCES channels(business_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- In-chat payments (money goes to the BUSINESS's own payment account)
-- ---------------------------------------------------------------------
CREATE TABLE merchant_payment_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('paystack','hubtel','mtn_momo')),
  credentials_enc     bytea NOT NULL,
  credentials_key_id  text NOT NULL,
  display_info        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- masked, non-secret
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider),
  UNIQUE (business_id, id)
);

CREATE TABLE payment_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  account_id          uuid NOT NULL,
  conversation_id     uuid,
  contact_id          uuid,
  message_id          uuid,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL DEFAULT 'GHS',
  description         text NOT NULL,
  method              payment_method,
  payer_msisdn        text CHECK (payer_msisdn ~ '^\+[1-9][0-9]{7,14}$'),
  provider            text NOT NULL,
  provider_reference  text,
  idempotency_key     text NOT NULL,
  status              payment_status NOT NULL DEFAULT 'pending',
  failure_reason      text,
  expires_at          timestamptz NOT NULL,
  paid_at             timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, account_id)      REFERENCES merchant_payment_accounts(business_id, id),
  -- Erasure of a contact keeps the financial record but drops the link (DPA + bookkeeping)
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (business_id, contact_id)      REFERENCES contacts(business_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (business_id, message_id)      REFERENCES messages(business_id, id) ON DELETE SET NULL (message_id)
);
CREATE UNIQUE INDEX payment_requests_provider_ref ON payment_requests (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX payment_requests_status_idx ON payment_requests (business_id, status, created_at DESC);
CREATE TRIGGER payment_requests_updated_at BEFORE UPDATE ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sales closed via chat (from a paid request, or recorded manually by an agent)
CREATE TABLE sales (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  conversation_id     uuid,
  contact_id          uuid,
  membership_id       uuid,
  payment_request_id  uuid UNIQUE,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL DEFAULT 'GHS',
  source              text NOT NULL CHECK (source IN ('payment_request','manual')),
  note                text,
  closed_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, conversation_id)    REFERENCES conversations(business_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (business_id, contact_id)         REFERENCES contacts(business_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (business_id, membership_id)      REFERENCES memberships(business_id, id) ON DELETE SET NULL (membership_id),
  FOREIGN KEY (business_id, payment_request_id) REFERENCES payment_requests(business_id, id) ON DELETE SET NULL (payment_request_id)
);
CREATE INDEX sales_reporting_idx ON sales (business_id, closed_at);
CREATE INDEX sales_agent_idx ON sales (business_id, membership_id, closed_at);

-- ---------------------------------------------------------------------
-- KasaDesk subscription billing
-- ---------------------------------------------------------------------
CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  number        text NOT NULL UNIQUE DEFAULT ('KD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')),
  plan_code     text NOT NULL REFERENCES plans(code),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  total_minor   bigint NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'GHS',
  status        invoice_status NOT NULL DEFAULT 'draft',
  due_at        timestamptz NOT NULL,
  paid_at       timestamptz,
  voided_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, period_start),          -- one invoice per period: idempotent invoice generation
  CHECK (period_end > period_start)
);

CREATE TABLE invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  line_type         text NOT NULL CHECK (line_type IN ('subscription','proration','meta_passthrough','adjustment')),
  description       text NOT NULL,
  quantity          numeric(12,3) NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  amount_minor      bigint NOT NULL,
  currency          char(3) NOT NULL DEFAULT 'GHS',
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices(business_id, id) ON DELETE CASCADE
);

CREATE TABLE billing_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  invoice_id          uuid NOT NULL,
  provider            text NOT NULL,
  provider_reference  text NOT NULL,
  method              payment_method NOT NULL,
  payer_msisdn        text,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL DEFAULT 'GHS',
  status              payment_status NOT NULL DEFAULT 'pending',
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference),
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices(business_id, id) ON DELETE CASCADE
);

-- Metered third-party fees (e.g. Meta WhatsApp per-message charges), recorded at cost, no markup.
CREATE TABLE usage_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  channel_id          uuid,
  source              text NOT NULL CHECK (source IN ('meta_whatsapp')),
  billed_by           text NOT NULL CHECK (billed_by IN ('meta_direct','kasadesk')),  -- who collects from the business
  category            text NOT NULL,          -- e.g. marketing / utility / authentication / service
  units               int NOT NULL DEFAULT 1 CHECK (units > 0),
  unit_cost_minor     bigint NOT NULL CHECK (unit_cost_minor >= 0),  -- provider's cost, unmodified
  currency            char(3) NOT NULL,       -- provider's billing currency (often USD)
  provider_reference  text NOT NULL,          -- e.g. wamid of the billable message
  occurred_at         timestamptz NOT NULL,
  invoice_id          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, provider_reference),
  FOREIGN KEY (business_id, channel_id) REFERENCES channels(business_id, id) ON DELETE SET NULL (channel_id),
  FOREIGN KEY (business_id, invoice_id) REFERENCES invoices(business_id, id) ON DELETE SET NULL (invoice_id)
);
CREATE INDEX usage_records_period_idx ON usage_records (business_id, occurred_at);

-- ---------------------------------------------------------------------
-- Compliance: data subject requests and audit log
-- ---------------------------------------------------------------------
CREATE TABLE data_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id         uuid,                  -- NULL = whole-business export / account deletion
  type               data_request_type NOT NULL,
  status             data_request_status NOT NULL DEFAULT 'pending',
  requested_by       uuid,                  -- membership id
  reason             text,
  result_storage_key text,                  -- export archive (signed URL issued on demand)
  result_expires_at  timestamptz,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX data_requests_idx ON data_requests (business_id, status, created_at DESC);

CREATE TABLE audit_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id    uuid NOT NULL,               -- no FK: logs survive tenant deletion until purged by policy
  actor_type     text NOT NULL CHECK (actor_type IN ('user','system','api')),
  actor_user_id  uuid,
  action         text NOT NULL,               -- e.g. 'channel.connected', 'member.role_changed', 'contact.erased'
  entity_type    text,
  entity_id      uuid,
  ip             inet,
  user_agent     text,
  changes        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- never contains secrets or message bodies
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_idx ON audit_logs (business_id, created_at DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'KD002';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ---------------------------------------------------------------------
-- System tables (no tenant RLS; not readable by kasadesk_app except as granted)
-- ---------------------------------------------------------------------
-- Raw inbound webhooks. The gateway verifies the signature, inserts here,
-- enqueues, and returns 200. dedupe_key makes provider retries no-ops.
CREATE TABLE webhook_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         text NOT NULL,           -- 'meta','hubtel','arkesel','paystack','email',...
  dedupe_key       text NOT NULL,           -- sha256 of the raw body, or the provider's event id
  business_id      uuid,                    -- resolved later by the worker
  signature_valid  boolean NOT NULL,
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  UNIQUE (provider, dedupe_key)
);
CREATE INDEX webhook_events_unprocessed ON webhook_events (received_at) WHERE processed_at IS NULL;

-- Transactional outbox: written in the same transaction as the domain change,
-- relayed to Redis/BullMQ by the worker, so no job is lost if Redis blips.
CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id   uuid NOT NULL,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'business_settings','business_hours','business_holidays','memberships','invitations',
    'channels','contacts','contact_identities','contact_consent_events','conversations',
    'messages','message_attachments','conversation_notes','conversation_events','tags',
    'conversation_tags','contact_tags','canned_responses','automation_rules','automation_runs',
    'whatsapp_templates','merchant_payment_accounts','payment_requests','sales','invoices',
    'invoice_lines','billing_payments','usage_records','data_requests','outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (business_id = app_business_id()) WITH CHECK (business_id = app_business_id())', t);
  END LOOP;
END $$;

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses
  USING (id = app_business_id()) WITH CHECK (id = app_business_id());

-- Audit log: tenants can read and append, never change.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read   ON audit_logs FOR SELECT USING (business_id = app_business_id());
CREATE POLICY audit_append ON audit_logs FOR INSERT WITH CHECK (business_id = app_business_id());

-- Users: visible to themselves and to members of the current business.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT USING (
  id = app_user_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.business_id = app_business_id())
);
CREATE POLICY users_signup ON users FOR INSERT WITH CHECK (id = app_user_id());
CREATE POLICY users_self_update ON users FOR UPDATE USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- ---------------------------------------------------------------------
-- Narrow pre-tenant lookups (SECURITY DEFINER; owner bypasses RLS).
-- These are the ONLY ways to read across tenants from kasadesk_app.
-- ---------------------------------------------------------------------
-- Webhook routing: provider account id -> tenant.
CREATE FUNCTION resolve_channel(p_type channel_type, p_external_id text)
RETURNS TABLE (business_id uuid, channel_id uuid, status channel_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.business_id, c.id, c.status FROM channels c
   WHERE c.type = p_type AND c.external_id = p_external_id
$$;

-- Login: fetch credentials by email.
CREATE FUNCTION auth_lookup_user(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, disabled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.password_hash, u.disabled_at FROM users u WHERE u.email = p_email
$$;

-- Business switcher after login.
CREATE FUNCTION auth_user_businesses(p_user_id uuid)
RETURNS TABLE (business_id uuid, business_name text, role member_role, subscription_status subscription_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.id, b.name, m.role, b.subscription_status
    FROM memberships m JOIN businesses b ON b.id = m.business_id
   WHERE m.user_id = p_user_id AND m.status = 'active' AND b.deleted_at IS NULL
   ORDER BY b.name
$$;

-- Invitation acceptance: token -> business.
CREATE FUNCTION auth_find_invitation(p_token_hash bytea)
RETURNS TABLE (invitation_id uuid, business_id uuid, email citext, role member_role, expires_at timestamptz, accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.business_id, i.email, i.role, i.expires_at, i.accepted_at
    FROM invitations i WHERE i.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION resolve_channel(channel_type, text), auth_lookup_user(citext),
  auth_user_businesses(uuid), auth_find_invitation(bytea) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO kasadesk_app, kasadesk_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kasadesk_app, kasadesk_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kasadesk_app, kasadesk_system;
GRANT EXECUTE ON FUNCTION resolve_channel(channel_type, text), auth_lookup_user(citext),
  auth_user_businesses(uuid), auth_find_invitation(bytea) TO kasadesk_app, kasadesk_system;

-- Catalogue / system tables: app gets only what it needs.
REVOKE INSERT, UPDATE, DELETE ON plans FROM kasadesk_app;
REVOKE UPDATE, DELETE ON audit_logs FROM kasadesk_app, kasadesk_system;
REVOKE SELECT, UPDATE, DELETE ON webhook_events FROM kasadesk_app;   -- gateway may only INSERT
REVOKE ALL ON schema_migrations FROM kasadesk_app, kasadesk_system;

INSERT INTO schema_migrations (version) VALUES ('0001_init');

COMMIT;
