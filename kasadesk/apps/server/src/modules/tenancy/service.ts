import { normalizePhone } from '@kasadesk/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../platform/audit.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import { Errors } from '../../platform/errors.ts';
import type { TenantState } from '../../platform/http/types.ts';
import type { SessionMeta } from '../auth/sessions.ts';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const optionalPhone = z.string().nullable().transform((v, ctx) => {
  if (v === null || v === '') return null;
  const n = normalizePhone(v);
  if (!n) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid phone number' });
  return n;
});

export const UpdateBusinessBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: optionalPhone.optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'Unknown time zone').optional(),
  billingMsisdn: optionalPhone.optional(),
  billingEmail: z.string().trim().toLowerCase().email().nullable().optional(),
  dataRetentionDays: z.number().int().min(30).max(3650).optional(),
}).strict();

export const UpdateSettingsBody = z.object({
  routingStrategy: z.enum(['round_robin', 'least_busy', 'skill_based']).optional(),
  slaFirstResponseSeconds: z.number().int().min(60).max(86_400).optional(),
  slaEscalationSeconds: z.number().int().min(120).max(172_800).optional(),
  autoReassignOnOffline: z.boolean().optional(),
  offlineGraceSeconds: z.number().int().min(30).max(3600).optional(),
  maxOpenPerAgent: z.number().int().min(1).max(200).optional(),
  autoGreetingEnabled: z.boolean().optional(),
  autoGreetingText: z.string().trim().min(1).max(1000).optional(),
  awayMessageEnabled: z.boolean().optional(),
  awayMessageText: z.string().trim().min(1).max(1000).optional(),
  queuePositionEnabled: z.boolean().optional(),
  defaultLanguage: z.enum(['en', 'tw', 'pcm']).optional(),
}).strict();

export const HoursBody = z.object({
  hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), opensAt: time, closesAt: time }))
    .max(21)
    .refine((hs) => hs.every((h) => h.closesAt > h.opensAt), 'closesAt must be after opensAt')
    .refine((hs) => {
      const byDay = new Map<number, { opensAt: string; closesAt: string }[]>();
      hs.forEach((h) => byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), h]));
      return [...byDay.values()].every((d) => d.sort((a, b) => a.opensAt.localeCompare(b.opensAt))
        .every((h, i) => i === 0 || h.opensAt >= d[i - 1]!.closesAt));
    }, 'Opening periods on the same day must not overlap'),
});

export const UpdateMemberBody = z.object({
  role: z.enum(['admin', 'agent']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  displayName: z.string().trim().min(1).max(80).nullable().optional(),
  skills: z.array(z.string().regex(/^[a-z]+:[a-z0-9_-]{1,40}$/, 'Use kind:value, e.g. lang:tw or product:phones')).max(30).optional(),
  maxConcurrent: z.number().int().min(1).max(200).nullable().optional(),
}).strict();

const SETTINGS_COLUMNS = {
  routingStrategy: 'routing_strategy', slaFirstResponseSeconds: 'sla_first_response_seconds',
  slaEscalationSeconds: 'sla_escalation_seconds', autoReassignOnOffline: 'auto_reassign_on_offline',
  offlineGraceSeconds: 'offline_grace_seconds', maxOpenPerAgent: 'max_open_per_agent',
  autoGreetingEnabled: 'auto_greeting_enabled', autoGreetingText: 'auto_greeting_text',
  awayMessageEnabled: 'away_message_enabled', awayMessageText: 'away_message_text',
  queuePositionEnabled: 'queue_position_enabled', defaultLanguage: 'default_language',
} as const;

export class TenancyService {
  constructor(private readonly db: DB) {}

  getBusiness(t: TenantState) {
    return withTenant(this.db, t, (tx) =>
      tx.selectFrom('businesses').select([
        'id', 'name', 'slug', 'phone_e164', 'email', 'country', 'timezone', 'plan_code', 'billing_msisdn',
        'billing_email', 'data_retention_days', 'created_at',
      ]).executeTakeFirstOrThrow(),
    );
  }

  async updateBusiness(t: TenantState, input: z.infer<typeof UpdateBusinessBody>, meta: SessionMeta) {
    if (input.dataRetentionDays !== undefined && t.role !== 'owner') throw Errors.forbidden('only_owner_can_change_retention');
    const patch = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.phone !== undefined && { phone_e164: input.phone }),
      ...(input.email !== undefined && { email: input.email }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
      ...(input.billingMsisdn !== undefined && { billing_msisdn: input.billingMsisdn }),
      ...(input.billingEmail !== undefined && { billing_email: input.billingEmail }),
      ...(input.dataRetentionDays !== undefined && { data_retention_days: input.dataRetentionDays }),
    };
    if (Object.keys(patch).length === 0) return this.getBusiness(t);
    await withTenant(this.db, t, async (tx) => {
      await tx.updateTable('businesses').set(patch).where('id', '=', t.businessId).execute();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'business.updated', entityType: 'business', entityId: t.businessId, changes: { fields: Object.keys(patch) }, ...meta });
    });
    return this.getBusiness(t);
  }

  getSettings(t: TenantState) {
    return withTenant(this.db, t, (tx) => tx.selectFrom('business_settings').selectAll().executeTakeFirstOrThrow());
  }

  async updateSettings(t: TenantState, input: z.infer<typeof UpdateSettingsBody>, meta: SessionMeta) {
    const patch: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(SETTINGS_COLUMNS)) {
      const v = input[k as keyof typeof input];
      if (v !== undefined) patch[col] = v;
    }
    if (Object.keys(patch).length === 0) return this.getSettings(t);
    return withTenant(this.db, t, async (tx) => {
      const current = await tx.selectFrom('business_settings').select(['sla_first_response_seconds', 'sla_escalation_seconds']).executeTakeFirstOrThrow();
      const first = (patch.sla_first_response_seconds as number | undefined) ?? current.sla_first_response_seconds;
      const second = (patch.sla_escalation_seconds as number | undefined) ?? current.sla_escalation_seconds;
      if (second <= first) throw Errors.badRequest('validation_failed', 'The second escalation must come after the first.');
      await tx.updateTable('business_settings').set(patch).where('business_id', '=', t.businessId).execute();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'settings.updated', changes: { fields: Object.keys(patch) }, ...meta });
      return tx.selectFrom('business_settings').selectAll().executeTakeFirstOrThrow();
    });
  }

  getHours(t: TenantState) {
    return withTenant(this.db, t, (tx) =>
      tx.selectFrom('business_hours').select(['weekday', 'opens_at', 'closes_at']).orderBy('weekday').orderBy('opens_at').execute(),
    );
  }

  async replaceHours(t: TenantState, input: z.infer<typeof HoursBody>, meta: SessionMeta) {
    await withTenant(this.db, t, async (tx) => {
      await tx.deleteFrom('business_hours').where('business_id', '=', t.businessId).execute();
      if (input.hours.length) {
        await tx.insertInto('business_hours').values(input.hours.map((h) => ({
          business_id: t.businessId, weekday: h.weekday, opens_at: h.opensAt, closes_at: h.closesAt,
        }))).execute();
      }
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'hours.updated', ...meta });
    });
    return this.getHours(t);
  }

  listMembers(t: TenantState) {
    return withTenant(this.db, t, (tx) =>
      tx.selectFrom('memberships').innerJoin('users', 'users.id', 'memberships.user_id')
        .select([
          'memberships.id', 'memberships.role', 'memberships.status', 'memberships.display_name',
          'memberships.skills', 'memberships.max_concurrent', 'memberships.presence', 'memberships.last_seen_at',
          'users.full_name', 'users.email', 'memberships.created_at',
        ])
        .orderBy('memberships.created_at').execute(),
    );
  }

  async updateMember(t: TenantState, memberId: string, input: z.infer<typeof UpdateMemberBody>, meta: SessionMeta) {
    return withTenant(this.db, t, async (tx) => {
      const target = await tx.selectFrom('memberships').select(['id', 'role', 'status', 'user_id'])
        .where('id', '=', memberId).executeTakeFirst();
      if (!target) throw Errors.notFound();
      if (target.role === 'owner' && (input.role !== undefined || input.status !== undefined)) {
        throw Errors.forbidden('cannot_change_owner', 'The owner cannot be demoted or disabled. Transfer ownership first.');
      }
      if (target.id === t.membershipId && input.status === 'disabled') throw Errors.forbidden('cannot_disable_self');
      const touchesAdmin = input.role === 'admin' || target.role === 'admin';
      if (t.role !== 'owner' && touchesAdmin && (input.role !== undefined || input.status !== undefined)) {
        throw Errors.forbidden('only_owner_manages_admins');
      }
      const patch = {
        ...(input.role !== undefined && { role: input.role }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.displayName !== undefined && { display_name: input.displayName }),
        ...(input.skills !== undefined && { skills: input.skills }),
        ...(input.maxConcurrent !== undefined && { max_concurrent: input.maxConcurrent }),
      };
      if (Object.keys(patch).length) {
        // Re-activation goes through the seat-limit trigger (KD001 -> 402).
        await tx.updateTable('memberships').set(patch).where('id', '=', memberId).execute();
        await audit(tx, {
          businessId: t.businessId, actorUserId: t.userId, action: 'member.updated', entityType: 'membership', entityId: memberId,
          changes: { ...(input.role && { role: [target.role, input.role] }), ...(input.status && { status: [target.status, input.status] }), fields: Object.keys(patch) },
          ...meta,
        });
      }
      return tx.selectFrom('memberships').selectAll().where('id', '=', memberId).executeTakeFirstOrThrow();
    });
  }

  listAuditLogs(t: TenantState, q: { limit: number; before?: string }) {
    return withTenant(this.db, t, (tx) => {
      let query = tx.selectFrom('audit_logs').selectAll().orderBy('id', 'desc').limit(q.limit);
      if (q.before) query = query.where(sql`id`, '<', q.before);
      return query.execute();
    });
  }
}
