/**
 * Kysely table types. Hand-written and extended step by step; must match db/migrations.
 * pg returns timestamptz as Date, int8/count as string.
 */
import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T = Record<string, unknown>> = ColumnType<T, string | undefined, string>;

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'read_only' | 'paused' | 'cancelled';
export type MemberRole = 'owner' | 'admin' | 'agent';
export type MemberStatus = 'invited' | 'active' | 'disabled';
export type RoutingStrategy = 'round_robin' | 'least_busy' | 'skill_based';
export type Language = 'en' | 'tw' | 'pcm';

export interface PlansTable {
  code: string;
  name: string;
  price_minor: ColumnType<string, number, number>;
  currency: string;
  max_agents: number;
  features: Json;
  is_active: boolean;
  sort_order: number;
}

export interface BusinessesTable {
  id: string;
  name: string;
  slug: string;
  phone_e164: string | null;
  email: string | null;
  country: Generated<string>;
  timezone: Generated<string>;
  plan_code: Generated<string>;
  subscription_status: Generated<SubscriptionStatus>;
  trial_started_at: Generated<Date>;
  trial_ends_at: Timestamp;
  current_period_start: NullableTimestamp;
  current_period_end: NullableTimestamp;
  grace_ends_at: NullableTimestamp;
  read_only_ends_at: NullableTimestamp;
  paused_at: NullableTimestamp;
  billing_msisdn: string | null;
  billing_email: string | null;
  data_retention_days: Generated<number>;
  status_changed_at: Generated<Date>;
  deleted_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BusinessSettingsTable {
  business_id: string;
  routing_strategy: Generated<RoutingStrategy>;
  sla_first_response_seconds: Generated<number>;
  sla_escalation_seconds: Generated<number>;
  auto_reassign_on_offline: Generated<boolean>;
  offline_grace_seconds: Generated<number>;
  max_open_per_agent: Generated<number>;
  auto_greeting_enabled: Generated<boolean>;
  auto_greeting_text: Generated<string>;
  away_message_enabled: Generated<boolean>;
  away_message_text: Generated<string>;
  queue_position_enabled: Generated<boolean>;
  default_language: Generated<Language>;
  updated_at: Generated<Date>;
}

export interface BusinessHoursTable {
  business_id: string;
  weekday: number;
  opens_at: string;
  closes_at: string;
}

export interface UsersTable {
  id: string;
  email: string;
  phone_e164: string | null;
  password_hash: string;
  full_name: string;
  email_verified_at: NullableTimestamp;
  phone_verified_at: NullableTimestamp;
  last_login_at: NullableTimestamp;
  disabled_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipsTable {
  id: string;
  business_id: string;
  user_id: string;
  role: Generated<MemberRole>;
  status: Generated<MemberStatus>;
  display_name: string | null;
  skills: Generated<string[]>;
  max_concurrent: number | null;
  presence: Generated<'online' | 'away' | 'offline'>;
  last_seen_at: NullableTimestamp;
  last_assigned_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InvitationsTable {
  id: string;
  business_id: string;
  email: string;
  role: MemberRole;
  token_hash: Buffer;
  invited_by: string;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface AuthSessionsTable {
  id: string;
  user_id: string;
  business_id: string | null;
  family_id: string;
  token_hash: Buffer;
  expires_at: Timestamp;
  rotated_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  ip: string | null;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface PasswordResetTokensTable {
  id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  business_id: string;
  actor_type: 'user' | 'system' | 'api';
  actor_user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip: string | null;
  user_agent: string | null;
  changes: Json;
  created_at: Generated<Date>;
}

export type ChannelType = 'whatsapp' | 'instagram' | 'messenger' | 'sms' | 'email' | 'webchat';
export type ChannelStatus = 'pending' | 'active' | 'error' | 'disconnected';
export type ConversationStatus = 'open' | 'pending' | 'snoozed' | 'resolved';
export type MessageDirection = 'inbound' | 'outbound';
export type SenderType = 'contact' | 'agent' | 'bot' | 'system';
export type MessageKind =
  | 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact_card'
  | 'template' | 'interactive' | 'reaction' | 'payment_request' | 'unsupported';
export type MessageStatus = 'received' | 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type ConsentStatus = 'unknown' | 'granted' | 'withdrawn';

export interface ChannelsTable {
  id: string;
  business_id: string;
  type: ChannelType;
  name: string;
  external_id: string;
  external_parent_id: string | null;
  credentials_enc: Buffer | null;
  credentials_key_id: string | null;
  config: Json;
  status: Generated<ChannelStatus>;
  last_error: string | null;
  webhook_key: string | null;
  connected_at: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ContactsTable {
  id: string;
  business_id: string;
  display_name: string | null;
  phone_e164: string | null;
  email: string | null;
  preferred_language: 'en' | 'tw' | 'pcm' | 'other' | null;
  ghana_post_gps: string | null;
  gps_lat: string | null;
  gps_lng: string | null;
  address_note: string | null;
  attributes: Json;
  consent_status: Generated<ConsentStatus>;
  blocked: Generated<boolean>;
  merged_into_id: string | null;
  first_seen_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ContactIdentitiesTable {
  id: string;
  business_id: string;
  contact_id: string;
  channel_id: string;
  channel_type: ChannelType;
  handle: string;
  profile: Json;
  created_at: Generated<Date>;
}

export interface ContactConsentEventsTable {
  id: string;
  business_id: string;
  contact_id: string;
  status: ConsentStatus;
  purpose: 'service' | 'marketing';
  source: string;
  evidence: Json;
  recorded_by: string | null;
  created_at: Generated<Date>;
}

export interface ConversationsTable {
  id: string;
  business_id: string;
  contact_id: string;
  channel_id: string;
  status: Generated<ConversationStatus>;
  assignee_id: string | null;
  priority: Generated<number>;
  subject: string | null;
  language: 'en' | 'tw' | 'pcm' | 'other' | null;
  required_skill: string | null;
  queued_at: NullableTimestamp;
  first_assigned_at: NullableTimestamp;
  first_response_at: NullableTimestamp;
  sla_due_at: NullableTimestamp;
  sla_level: Generated<number>;
  sla_breached: Generated<boolean>;
  last_inbound_at: NullableTimestamp;
  last_outbound_at: NullableTimestamp;
  last_message_at: Generated<Date>;
  last_message_preview: string | null;
  unread_count: Generated<number>;
  snoozed_until: NullableTimestamp;
  resolved_at: NullableTimestamp;
  resolved_by: string | null;
  reopened_count: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MessagesTable {
  id: string;
  business_id: string;
  conversation_id: string;
  contact_id: string;
  channel_id: string;
  direction: MessageDirection;
  sender_type: SenderType;
  sender_id: string | null;
  kind: Generated<MessageKind>;
  body: string | null;
  payload: Json;
  provider_message_id: string | null;
  client_id: string | null;
  reply_to_id: string | null;
  status: MessageStatus;
  error_code: string | null;
  error_message: string | null;
  attempts: Generated<number>;
  language: 'en' | 'tw' | 'pcm' | 'other' | null;
  transcript: string | null;
  claimed_at: NullableTimestamp;
  created_at: Generated<Date>;
  sent_at: NullableTimestamp;
  delivered_at: NullableTimestamp;
  read_at: NullableTimestamp;
  failed_at: NullableTimestamp;
}

export interface MessageAttachmentsTable {
  id: string;
  business_id: string;
  message_id: string;
  mime_type: string;
  size_bytes: ColumnType<string | null, number | null | undefined, number | null>;
  filename: string | null;
  storage_key: string | null;
  provider_media_id: string | null;
  sha256: Buffer | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  created_at: Generated<Date>;
}

export interface ConversationEventsTable {
  id: string;
  business_id: string;
  conversation_id: string;
  type: string;
  actor_type: Generated<SenderType>;
  actor_id: string | null;
  data: Json;
  created_at: Generated<Date>;
}

export interface WhatsappTemplatesTable {
  id: string;
  business_id: string;
  channel_id: string;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  status: string;
  components: Json<unknown[]>;
  provider_template_id: string | null;
  rejected_reason: string | null;
  synced_at: Generated<Date>;
}

export interface OutboxTable {
  id: Generated<string>;
  business_id: string;
  topic: string;
  payload: Json;
  created_at: Generated<Date>;
  published_at: NullableTimestamp;
}

export interface WebhookEventsTable {
  id: Generated<string>;
  provider: string;
  dedupe_key: string;
  business_id: string | null;
  channel_id: string | null;
  signature_valid: boolean;
  payload: Json;
  received_at: Generated<Date>;
  processed_at: NullableTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface Database {
  channels: ChannelsTable;
  contacts: ContactsTable;
  contact_identities: ContactIdentitiesTable;
  contact_consent_events: ContactConsentEventsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  message_attachments: MessageAttachmentsTable;
  conversation_events: ConversationEventsTable;
  whatsapp_templates: WhatsappTemplatesTable;
  outbox: OutboxTable;
  webhook_events: WebhookEventsTable;
  plans: PlansTable;
  businesses: BusinessesTable;
  business_settings: BusinessSettingsTable;
  business_hours: BusinessHoursTable;
  users: UsersTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  auth_sessions: AuthSessionsTable;
  password_reset_tokens: PasswordResetTokensTable;
  audit_logs: AuditLogsTable;
}
