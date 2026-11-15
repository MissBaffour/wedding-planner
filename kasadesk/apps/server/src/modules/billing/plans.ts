import { sql } from 'kysely';
import { audit } from '../../platform/audit.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import { Errors } from '../../platform/errors.ts';
import type { TenantState } from '../../platform/http/types.ts';
import type { SessionMeta } from '../auth/sessions.ts';
import { daysLeft, timeline } from './subscription.ts';

export class PlanService {
  constructor(private readonly db: DB) {}

  async listPlans() {
    const rows = await this.db.selectFrom('plans').selectAll().where('is_active', '=', true).orderBy('sort_order').execute();
    return rows.map((p) => ({
      code: p.code, name: p.name, priceMinor: Number(p.price_minor), currency: p.currency,
      priceDisplay: `GH₵${(Number(p.price_minor) / 100).toLocaleString('en-GH', { minimumFractionDigits: 0 })}`,
      maxAgents: p.max_agents, features: p.features,
    }));
  }

  async subscription(t: TenantState) {
    return withTenant(this.db, t, async (tx) => {
      const b = await tx.selectFrom('businesses')
        .select(['plan_code', 'subscription_status', 'trial_ends_at', 'current_period_start', 'current_period_end'])
        .executeTakeFirstOrThrow();
      const seats = await sql<{ n: string }>`select count(*) as n from memberships where status = 'active'`.execute(tx);
      const plan = await tx.selectFrom('plans').select(['max_agents']).where('code', '=', b.plan_code).executeTakeFirstOrThrow();
      const tl = timeline(b);
      return {
        planCode: b.plan_code,
        status: tl.status,
        accessLevel: t.accessLevel,
        trialEndsAt: b.current_period_end ? null : b.trial_ends_at,
        currentPeriodStart: b.current_period_start,
        currentPeriodEnd: b.current_period_end,
        graceEndsAt: tl.graceEndsAt,
        fullAccessEndsAt: tl.fullAccessEndsAt,
        readOnlyEndsAt: tl.readOnlyEndsAt,
        daysLeft: daysLeft(tl.status === 'read_only' ? tl.readOnlyEndsAt : tl.fullAccessEndsAt),
        seats: { used: Number(seats.rows[0]!.n), max: plan.max_agents },
      };
    });
  }

  /**
   * Choose a plan during the free trial (no payment yet). Paid upgrades and
   * downgrades go through checkout in step 7.
   */
  async choosePlanDuringTrial(t: TenantState, planCode: string, meta: SessionMeta) {
    if (t.status !== 'trialing') {
      throw Errors.conflict('use_checkout', 'Plan changes after the trial are made at checkout.');
    }
    return withTenant(this.db, t, async (tx) => {
      const plan = await tx.selectFrom('plans').select(['code', 'max_agents']).where('code', '=', planCode)
        .where('is_active', '=', true).executeTakeFirst();
      if (!plan) throw Errors.badRequest('unknown_plan');
      // Same lock as the seat trigger, so a concurrent invite cannot slip past.
      await sql`select pg_advisory_xact_lock(hashtextextended(${'seats:' + t.businessId}, 0))`.execute(tx);
      const r = await sql<{ n: string }>`select count(*) as n from memberships where status = 'active'`.execute(tx);
      const active = Number(r.rows[0]!.n);
      if (active > plan.max_agents) {
        throw Errors.conflict('too_many_members_for_plan',
          `This plan allows ${plan.max_agents} members; you have ${active} active. Disable some members first.`,
          { active, maxAgents: plan.max_agents });
      }
      const before = await tx.selectFrom('businesses').select('plan_code').executeTakeFirstOrThrow();
      await tx.updateTable('businesses').set({ plan_code: plan.code }).where('id', '=', t.businessId).execute();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'plan.changed', changes: { from: before.plan_code, to: plan.code }, ...meta });
      return { planCode: plan.code, maxAgents: plan.max_agents };
    });
  }
}
