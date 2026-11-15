import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, api, makeTestApp, signup, uniq, type TestCtx } from '../helpers.ts';

let ctx: TestCtx;
beforeAll(async () => { ctx = await makeTestApp(); });
afterAll(async () => ctx.close());

describe('tenant isolation through the API', () => {
  it('a member of business A cannot see or touch business B', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    const bMembers = (await api(ctx.app, b.token).get('/v1/members')).json();
    const bOwnerMembershipId = bMembers[0].id;

    // A cannot update B's member: the row is invisible under A's RLS context.
    const res = await api(ctx.app, a.token).patch(`/v1/members/${bOwnerMembershipId}`, { displayName: 'hacked' });
    expect(res.statusCode).toBe(404);

    // A's lists contain only A's data.
    const aMembers = (await api(ctx.app, a.token).get('/v1/members')).json();
    expect(aMembers.map((m: { id: string }) => m.id)).not.toContain(bOwnerMembershipId);
    expect((await api(ctx.app, a.token).get('/v1/business')).json().id).toBe(a.businessId);
  });

  it('cannot switch into a business you do not belong to', async () => {
    const a = await signup(ctx.app);
    const b = await signup(ctx.app);
    const res = await ctx.app.inject({
      method: 'POST', url: '/v1/auth/switch-business',
      headers: { authorization: `Bearer ${a.token}`, 'x-kasadesk-csrf': '1' },
      payload: { businessId: b.businessId },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('invitations and roles', () => {
  it('owner invites an agent who joins with a new account', async () => {
    const o = await signup(ctx.app);
    const m = await addMember(ctx, o.token, 'agent');
    expect(m.inviteRes.statusCode).toBe(201);
    expect(m.acceptRes!.statusCode).toBe(201);
    const me = (await api(ctx.app, m.accessToken).get('/v1/me')).json();
    expect(me.current).toMatchObject({ businessId: o.businessId, role: 'agent' });
  });

  it('an existing user joins a second business and can switch between them', async () => {
    const shopA = await signup(ctx.app);
    const shopB = await signup(ctx.app);
    // Owner of B invites owner of A
    await api(ctx.app, shopB.token).post('/v1/invitations', { email: shopA.email, role: 'agent' });
    const token = new URL(ctx.notifier.last('invitation')!.data.url as string).searchParams.get('token')!;
    const wrongPw = await api(ctx.app).post('/v1/invitations/accept', { token, password: 'not-their-password' });
    expect(wrongPw.statusCode).toBe(401);
    const ok = await api(ctx.app).post('/v1/invitations/accept', { token, password: shopA.password });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().businesses).toHaveLength(2);

    const sw = await ctx.app.inject({
      method: 'POST', url: '/v1/auth/switch-business',
      headers: { authorization: `Bearer ${shopA.token}`, 'x-kasadesk-csrf': '1' },
      payload: { businessId: shopB.businessId },
    });
    expect(sw.statusCode).toBe(200);
    expect((await api(ctx.app, sw.json().accessToken).get('/v1/me')).json().current.role).toBe('agent');
  });

  it('an invitation token works only once', async () => {
    const o = await signup(ctx.app);
    await api(ctx.app, o.token).post('/v1/invitations', { email: `${uniq()}@example.com` });
    const token = new URL(ctx.notifier.last('invitation')!.data.url as string).searchParams.get('token')!;
    expect((await api(ctx.app).post('/v1/invitations/accept', { token, password: 'agent-password-1', fullName: 'Esi' })).statusCode).toBe(201);
    expect((await api(ctx.app).post('/v1/invitations/accept', { token, password: 'agent-password-1', fullName: 'Esi' })).statusCode).toBe(400);
  });

  it('agents cannot change settings or invite; admins cannot manage admins', async () => {
    const o = await signup(ctx.app);
    const agent = await addMember(ctx, o.token, 'agent');
    const admin = await addMember(ctx, o.token, 'admin');

    expect((await api(ctx.app, agent.accessToken).patch('/v1/business/settings', { autoGreetingEnabled: false })).statusCode).toBe(403);
    expect((await api(ctx.app, agent.accessToken).post('/v1/invitations', { email: `${uniq()}@x.com` })).statusCode).toBe(403);
    expect((await api(ctx.app, agent.accessToken).get('/v1/audit-logs')).statusCode).toBe(403);
    expect((await api(ctx.app, agent.accessToken).get('/v1/members')).statusCode).toBe(200);

    expect((await api(ctx.app, admin.accessToken).patch('/v1/business/settings', { autoGreetingEnabled: false })).statusCode).toBe(200);
    expect((await api(ctx.app, admin.accessToken).post('/v1/invitations', { email: `${uniq()}@x.com`, role: 'admin' })).json().error.code)
      .toBe('only_owner_can_invite_admins');

    const members = (await api(ctx.app, o.token).get('/v1/members')).json() as { id: string; role: string }[];
    const ownerM = members.find((m) => m.role === 'owner')!;
    const adminM = members.find((m) => m.role === 'admin')!;
    expect((await api(ctx.app, admin.accessToken).patch(`/v1/members/${adminM.id}`, { status: 'disabled' })).statusCode).toBe(403);
    expect((await api(ctx.app, o.token).patch(`/v1/members/${ownerM.id}`, { role: 'agent' })).json().error.code).toBe('cannot_change_owner');
  });

  it('disabling a member cuts access immediately (no waiting for token expiry)', async () => {
    const o = await signup(ctx.app);
    const agent = await addMember(ctx, o.token, 'agent');
    const members = (await api(ctx.app, o.token).get('/v1/members')).json() as { id: string; role: string }[];
    const agentM = members.find((m) => m.role === 'agent')!;
    expect((await api(ctx.app, o.token).patch(`/v1/members/${agentM.id}`, { status: 'disabled', skills: ['lang:tw'] })).statusCode).toBe(200);
    const res = await api(ctx.app, agent.accessToken).get('/v1/business');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_a_member');
  });

  it('validates settings and hours', async () => {
    const o = await signup(ctx.app);
    expect((await api(ctx.app, o.token).patch('/v1/business/settings', { slaFirstResponseSeconds: 900, slaEscalationSeconds: 600 })).json().error.code)
      .toBe('validation_failed');
    expect((await api(ctx.app, o.token).patch('/v1/business/settings', { unknownField: 1 })).statusCode).toBe(400);
    const hours = await api(ctx.app, o.token).put('/v1/business/hours', {
      hours: [{ weekday: 1, opensAt: '08:00', closesAt: '12:00' }, { weekday: 1, opensAt: '11:00', closesAt: '17:00' }],
    });
    expect(hours.statusCode).toBe(400);
    const ok = await api(ctx.app, o.token).put('/v1/business/hours', {
      hours: [{ weekday: 1, opensAt: '08:00', closesAt: '12:00' }, { weekday: 1, opensAt: '13:00', closesAt: '17:00' }],
    });
    expect(ok.json()).toHaveLength(2);
    expect((await api(ctx.app, o.token).patch('/v1/business', { timezone: 'Mars/Olympus' })).statusCode).toBe(400);
  });

  it('records an audit trail', async () => {
    const o = await signup(ctx.app);
    await api(ctx.app, o.token).patch('/v1/business', { name: 'Renamed Shop' });
    const logs = (await api(ctx.app, o.token).get('/v1/audit-logs')).json() as { action: string }[];
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['business.created', 'terms.accepted', 'business.updated']));
  });
});

describe('plan enforcement: seats', () => {
  it('Starter allows 3 seats; the 4th invite is refused with 402', async () => {
    const o = await signup(ctx.app);
    expect((await api(ctx.app, o.token).post('/v1/billing/plan', { planCode: 'starter' })).statusCode).toBe(200);
    expect((await addMember(ctx, o.token)).acceptRes!.statusCode).toBe(201);
    expect((await addMember(ctx, o.token)).acceptRes!.statusCode).toBe(201);
    const fourth = await addMember(ctx, o.token);
    expect(fourth.inviteRes.statusCode).toBe(402);
    expect(fourth.inviteRes.json().error.code).toBe('seat_limit_reached');
    const sub = (await api(ctx.app, o.token).get('/v1/billing/subscription')).json();
    expect(sub.seats).toEqual({ used: 3, max: 3 });
  });

  it('pending invites count toward seats', async () => {
    const o = await signup(ctx.app);
    await api(ctx.app, o.token).post('/v1/billing/plan', { planCode: 'starter' });
    // Two pending invites fill the plan
    await api(ctx.app, o.token).post('/v1/invitations', { email: `${uniq()}@x.com` });
    const t1 = new URL(ctx.notifier.last('invitation')!.data.url as string).searchParams.get('token')!;
    await api(ctx.app, o.token).post('/v1/invitations', { email: `${uniq()}@x.com` });
    expect((await api(ctx.app, o.token).post('/v1/invitations', { email: `${uniq()}@x.com` })).statusCode).toBe(402);
    expect((await api(ctx.app).post('/v1/invitations/accept', { token: t1, password: 'agent-password-1', fullName: 'Abena' })).statusCode).toBe(201);
  });

  it('cannot downgrade below the number of active members; re-enabling respects seats', async () => {
    const o = await signup(ctx.app);
    for (let i = 0; i < 3; i++) await addMember(ctx, o.token); // 4 active on Growth
    const down = await api(ctx.app, o.token).post('/v1/billing/plan', { planCode: 'starter' });
    expect(down.statusCode).toBe(409);
    expect(down.json().error.code).toBe('too_many_members_for_plan');

    const members = (await api(ctx.app, o.token).get('/v1/members')).json() as { id: string; role: string }[];
    const agent = members.find((m) => m.role === 'agent')!;
    await api(ctx.app, o.token).patch(`/v1/members/${agent.id}`, { status: 'disabled' });
    await api(ctx.app, o.token).patch(`/v1/members/${members.filter((m) => m.role === 'agent')[1]!.id}`, { status: 'disabled' });
    expect((await api(ctx.app, o.token).post('/v1/billing/plan', { planCode: 'starter' })).statusCode).toBe(200);

    // owner + 1 active agent = 2 of 3. Re-enabling one fills the plan; the next is refused by the DB seat trigger.
    expect((await api(ctx.app, o.token).patch(`/v1/members/${agent.id}`, { status: 'active' })).statusCode).toBe(200);
    const again = await api(ctx.app, o.token).patch(`/v1/members/${members.filter((m) => m.role === 'agent')[1]!.id}`, { status: 'active' });
    expect(again.statusCode).toBe(402);
    expect(again.json().error.code).toBe('seat_limit_reached');
  });

  it('only the owner can choose the plan', async () => {
    const o = await signup(ctx.app);
    const admin = await addMember(ctx, o.token, 'admin');
    expect((await api(ctx.app, admin.accessToken).post('/v1/billing/plan', { planCode: 'business' })).statusCode).toBe(403);
  });
});
