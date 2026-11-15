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

export interface Database {
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
