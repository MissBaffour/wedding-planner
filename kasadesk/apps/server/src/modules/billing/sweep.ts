import { sql } from 'kysely';
import type { DB } from '../../platform/db/index.ts';
import type { SubscriptionStatus } from '../../platform/db/schema.ts';
import type { Notifier } from '../../platform/notify.ts';
import { daysLeft, deriveStatus, timeline } from './subscription.ts';

const DAY = 86_400_000;
/** Days before trial end; checked most-urgent first so each fires once. */
const TRIAL_REMINDERS = [1, 3] as const;
const MAX_REMINDER_DAYS = Math.max(...TRIAL_REMINDERS);

export interface SweepResult {
  transitions: { businessId: string; from: SubscriptionStatus; to: SubscriptionStatus }[];
  reminders: { businessId: string; kind: string }[];
  sessionsPurged: number;
}

/**
 * Runs in the worker with the SYSTEM pool (BYPASSRLS, cross-tenant):
 *  - persists derived status changes + their timestamps, audits and notifies the owner
 *  - sends trial-ending reminders once each
 *  - purges dead sessions and reset tokens
 * Idempotent: safe to run as often as you like or twice concurrently.
 */
export async function runSubscriptionSweep(sys: DB, notifier: Notifier, now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { transitions: [], reminders: [], sessionsPurged: 0 };

  const candidates = await sys.selectFrom('businesses')
    .select(['id', 'name', 'subscription_status', 'trial_ends_at', 'current_period_end', 'billing_email', 'billing_msisdn'])
    .where('deleted_at', 'is', null)
    .where('subscription_status', '<>', 'cancelled')
    .where((eb) => eb.or([
      eb('subscription_status', 'in', ['past_due', 'read_only']),
      eb.and([eb('current_period_end', 'is', null), eb('trial_ends_at', '<=', new Date(now.getTime() + MAX_REMINDER_DAYS * DAY))]),
      eb('current_period_end', '<=', now),
    ]))
    .execute();

  for (const b of candidates) {
    const next = deriveStatus(b, now);
    const to = { email: b.billing_email, phone: b.billing_msisdn };

    if (next !== b.subscription_status) {
      const tl = timeline(b, now);
      const changed = await sys.transaction().execute(async (tx) => {
        const r = await tx.updateTable('businesses')
          .set({
            subscription_status: next,
            status_changed_at: now,
            grace_ends_at: tl.graceEndsAt,
            read_only_ends_at: next === 'read_only' || next === 'paused' ? tl.readOnlyEndsAt : null,
            paused_at: next === 'paused' ? now : null,
          })
          .where('id', '=', b.id)
          .where('subscription_status', '=', b.subscription_status) // optimistic: skip if another sweep won
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) !== 1) return false;
        await tx.insertInto('audit_logs').values({
          business_id: b.id, actor_type: 'system', action: 'subscription.status_changed',
          changes: JSON.stringify({ from: b.subscription_status, to: next }),
        }).execute();
        return true;
      });
      if (changed) {
        result.transitions.push({ businessId: b.id, from: b.subscription_status, to: next });
        await notifier.send({
          to, template: 'subscription_status_changed',
          data: { businessName: b.name, from: b.subscription_status, to: next, readOnlyEndsAt: tl.readOnlyEndsAt },
        });
      }
    }

    if (next === 'trialing') {
      const left = daysLeft(b.trial_ends_at, now);
      for (const d of TRIAL_REMINDERS) {
        if (left > d) continue;
        const kind = `trial_${d}d`;
        // Record first, then send: at most one reminder of each kind (the unique key is the audit row).
        const inserted = await sql<{ id: string }>`
          insert into audit_logs (business_id, actor_type, action, changes)
          select ${b.id}, 'system', 'subscription.reminder_sent', ${JSON.stringify({ kind })}::jsonb
           where not exists (select 1 from audit_logs where business_id = ${b.id}
                               and action = 'subscription.reminder_sent' and changes->>'kind' = ${kind})
          returning id`.execute(sys);
        if (inserted.rows.length) {
          result.reminders.push({ businessId: b.id, kind });
          await notifier.send({ to, template: 'trial_ending', data: { businessName: b.name, daysLeft: left, trialEndsAt: b.trial_ends_at } });
        }
        break; // only the most urgent applicable reminder per run
      }
    }
  }

  const purged = await sys.deleteFrom('auth_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', now), eb('revoked_at', '<', new Date(now.getTime() - 7 * DAY))]))
    .executeTakeFirst();
  result.sessionsPurged = Number(purged.numDeletedRows);
  await sys.deleteFrom('password_reset_tokens').where('expires_at', '<', new Date(now.getTime() - DAY)).execute();

  return result;
}
