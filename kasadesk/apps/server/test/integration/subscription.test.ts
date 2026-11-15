import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSubscriptionSweep } from '../../src/modules/billing/sweep.ts';
import { api, makeTestApp, signup, type TestCtx } from '../helpers.ts';

const DAY = 86_400_000;
let ctx: TestCtx;
beforeAll(async () => { ctx = await makeTestApp(); });
afterAll(async () => ctx.close());

const setTrialEnd = (businessId: string, daysFromNow: number) =>
  ctx.sys.updateTable('businesses').set({ trial_ends_at: new Date(Date.now() + daysFromNow * DAY) }).where('id', '=', businessId).execute();

describe('trial enforcement at the API layer', () => {
  it('expired trial => read-only: reads work, writes get 402, billing still works', async () => {
    const o = await signup(ctx.app);
    await setTrialEnd(o.businessId, -1);

    const read = await api(ctx.app, o.token).get('/v1/business/settings');
    expect(read.statusCode).toBe(200);

    const write = await api(ctx.app, o.token).patch('/v1/business/settings', { autoGreetingEnabled: false });
    expect(write.statusCode).toBe(402);
    expect(write.json().error.code).toBe('subscription_read_only');

    expect((await api(ctx.app, o.token).get('/v1/billing/subscription')).json()).toMatchObject({ status: 'read_only', daysLeft: 6 });
    const me = (await api(ctx.app, o.token).get('/v1/me')).json();
    expect(me.current.subscription.accessLevel).toBe('read_only');
  });

  it('read-only for 7 days, then paused: reads blocked too, billing and /me still open', async () => {
    const o = await signup(ctx.app);
    await setTrialEnd(o.businessId, -8);
    const read = await api(ctx.app, o.token).get('/v1/members');
    expect(read.statusCode).toBe(402);
    expect(read.json().error.code).toBe('subscription_paused');
    expect((await api(ctx.app, o.token).get('/v1/billing/subscription')).statusCode).toBe(200);
    expect((await api(ctx.app, o.token).get('/v1/me')).statusCode).toBe(200);
    expect((await api(ctx.app).get('/v1/billing/plans')).statusCode).toBe(200);
  });

  it('paid period lapse gives 3 days grace with full access, then read-only', async () => {
    const o = await signup(ctx.app);
    const setPeriodEnd = (days: number) => ctx.sys.updateTable('businesses')
      .set({ subscription_status: 'active', current_period_end: new Date(Date.now() + days * DAY) })
      .where('id', '=', o.businessId).execute();

    await setPeriodEnd(-2); // inside grace
    expect((await api(ctx.app, o.token).patch('/v1/business/settings', { autoGreetingEnabled: false })).statusCode).toBe(200);
    expect((await api(ctx.app, o.token).get('/v1/billing/subscription')).json().status).toBe('past_due');

    await setPeriodEnd(-4); // grace over
    expect((await api(ctx.app, o.token).patch('/v1/business/settings', { autoGreetingEnabled: true })).statusCode).toBe(402);
  });

  it('plan choice is only allowed during the trial (paid changes go through checkout)', async () => {
    const o = await signup(ctx.app);
    await setTrialEnd(o.businessId, -1);
    const res = await api(ctx.app, o.token).post('/v1/billing/plan', { planCode: 'starter' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('use_checkout');
  });
});

describe('subscription sweep (worker)', () => {
  it('persists transitions, audits them and notifies the owner once', async () => {
    const o = await signup(ctx.app);
    await setTrialEnd(o.businessId, -1);

    const r1 = await runSubscriptionSweep(ctx.sys, ctx.notifier);
    expect(r1.transitions).toContainEqual({ businessId: o.businessId, from: 'trialing', to: 'read_only' });
    const b = await ctx.sys.selectFrom('businesses').selectAll().where('id', '=', o.businessId).executeTakeFirstOrThrow();
    expect(b.subscription_status).toBe('read_only');
    expect(b.read_only_ends_at).toBeInstanceOf(Date);

    const r2 = await runSubscriptionSweep(ctx.sys, ctx.notifier);
    expect(r2.transitions.find((t) => t.businessId === o.businessId)).toBeUndefined();

    const logs = (await api(ctx.app, o.token).get('/v1/audit-logs')).json() as { action: string }[];
    expect(logs.filter((l) => l.action === 'subscription.status_changed')).toHaveLength(1);
  });

  it('read_only -> paused after 7 more days', async () => {
    const o = await signup(ctx.app);
    await setTrialEnd(o.businessId, -1);
    await runSubscriptionSweep(ctx.sys, ctx.notifier);
    const r = await runSubscriptionSweep(ctx.sys, ctx.notifier, new Date(Date.now() + 7 * DAY));
    expect(r.transitions).toContainEqual({ businessId: o.businessId, from: 'read_only', to: 'paused' });
  });

  it('sends the 3-day and 1-day trial reminders exactly once each', async () => {
    const o = await signup(ctx.app);
    const mine = (r: Awaited<ReturnType<typeof runSubscriptionSweep>>) => r.reminders.filter((x) => x.businessId === o.businessId).map((x) => x.kind);

    await setTrialEnd(o.businessId, 2.5);
    expect(mine(await runSubscriptionSweep(ctx.sys, ctx.notifier))).toEqual(['trial_3d']);
    expect(mine(await runSubscriptionSweep(ctx.sys, ctx.notifier))).toEqual([]);

    await setTrialEnd(o.businessId, 0.5);
    expect(mine(await runSubscriptionSweep(ctx.sys, ctx.notifier))).toEqual(['trial_1d']);
    expect(mine(await runSubscriptionSweep(ctx.sys, ctx.notifier))).toEqual([]);
  });
});
