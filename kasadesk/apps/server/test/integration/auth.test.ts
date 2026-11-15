import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeTestApp, refreshCookie, signup, uniq, type TestCtx } from '../helpers.ts';

let ctx: TestCtx;
beforeAll(async () => { ctx = await makeTestApp({ LOGIN_MAX_FAILURES_PER_EMAIL: '3' }); });
afterAll(async () => ctx.close());

const refresh = (cookie: string) =>
  ctx.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { 'x-kasadesk-csrf': '1' }, cookies: { kd_rt: cookie } });

describe('signup', () => {
  it('creates user, business, owner membership and a 14-day Growth trial', async () => {
    const s = await signup(ctx.app);
    expect(s.token).toBeTruthy();
    expect(s.cookie).toBeTruthy();
    const me = (await api(ctx.app, s.token).get('/v1/me')).json();
    expect(me.current.role).toBe('owner');
    expect(me.current.plan).toMatchObject({ code: 'growth', maxAgents: 8 });
    expect(me.current.subscription.status).toBe('trialing');
    expect(me.current.subscription.accessLevel).toBe('full');
    expect(me.current.subscription.daysLeft).toBe(14);

    const hours = (await api(ctx.app, s.token).get('/v1/business/hours')).json();
    expect(hours).toHaveLength(6);
    const biz = (await api(ctx.app, s.token).get('/v1/business')).json();
    expect(biz.phone_e164).toMatch(/^\+23324\d{7}$/);
    expect(biz.timezone).toBe('Africa/Accra');
  });

  it('sets the refresh cookie httpOnly + SameSite=Strict, never in the body', async () => {
    const res = await api(ctx.app).post('/v1/auth/signup', {
      businessName: 'Kofi Electronics', fullName: 'Kofi Boateng', email: `${uniq()}@example.com`,
      password: 'long-enough-pass', acceptTerms: true,
    });
    const c = res.cookies.find((x) => x.name === 'kd_rt')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
    expect(c.path).toBe('/v1/auth');
    expect(res.json().refreshToken).toBeUndefined();
  });

  it('rejects duplicate email, weak password, missing consent and bad phone', async () => {
    const s = await signup(ctx.app);
    const base = { businessName: 'Dup Shop', fullName: 'Dup', password: 'long-enough-pass', acceptTerms: true };
    expect((await api(ctx.app).post('/v1/auth/signup', { ...base, email: s.email.toUpperCase() })).json().error.code).toBe('email_taken');
    expect((await api(ctx.app).post('/v1/auth/signup', { ...base, email: `${uniq()}@x.com`, password: 'short' })).statusCode).toBe(400);
    expect((await api(ctx.app).post('/v1/auth/signup', { ...base, email: `${uniq()}@x.com`, acceptTerms: false })).statusCode).toBe(400);
    const bad = await api(ctx.app).post('/v1/auth/signup', { ...base, email: `${uniq()}@x.com`, phone: '12' });
    expect(bad.json().error.details[0].path).toBe('phone');
  });

  it('refuses a phone already used by another account with a clear error', async () => {
    const first = await api(ctx.app).post('/v1/auth/signup', {
      businessName: 'Phone One', fullName: 'Efua', email: `${uniq()}@x.com`, password: 'long-enough-pass', phone: '0559990001', acceptTerms: true,
    });
    expect(first.statusCode).toBe(201);
    const second = await api(ctx.app).post('/v1/auth/signup', {
      businessName: 'Phone Two', fullName: 'Efua', email: `${uniq()}@x.com`, password: 'long-enough-pass', phone: '+233 55 999 0001', acceptTerms: true,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('phone_taken');
  });
});

describe('login', () => {
  it('logs in case-insensitively and returns the business list', async () => {
    const s = await signup(ctx.app);
    const res = await api(ctx.app).post('/v1/auth/login', { email: s.email.toUpperCase(), password: s.password });
    expect(res.statusCode).toBe(200);
    expect(res.json().businessId).toBe(s.businessId);
    expect(res.json().businesses).toHaveLength(1);
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const s = await signup(ctx.app);
    const a = await api(ctx.app).post('/v1/auth/login', { email: s.email, password: 'wrong-password' });
    const b = await api(ctx.app).post('/v1/auth/login', { email: `${uniq()}@nobody.com`, password: 'wrong-password' });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error).toEqual(b.json().error);
  });

  it('locks an email after repeated failures, even with the right password', async () => {
    const s = await signup(ctx.app);
    for (let i = 0; i < 3; i++) await api(ctx.app).post('/v1/auth/login', { email: s.email, password: 'nope-nope-nope' });
    const res = await api(ctx.app).post('/v1/auth/login', { email: s.email, password: s.password });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('too_many_attempts');
  });
});

describe('refresh token rotation', () => {
  it('rotates the token on each refresh', async () => {
    const s = await signup(ctx.app);
    const r1 = await refresh(s.cookie);
    expect(r1.statusCode).toBe(200);
    const c1 = refreshCookie(r1)!;
    expect(c1).not.toBe(s.cookie);
    expect((await api(ctx.app, r1.json().accessToken).get('/v1/business')).statusCode).toBe(200);
  });

  it('tolerates a replay inside the grace window (lost response on bad network)', async () => {
    const s = await signup(ctx.app);
    expect((await refresh(s.cookie)).statusCode).toBe(200);
    const retry = await refresh(s.cookie);
    expect(retry.statusCode).toBe(200);
  });

  it('revokes the whole family when an old token is reused after the grace window', async () => {
    const s = await signup(ctx.app);
    const r1 = await refresh(s.cookie);
    const c1 = refreshCookie(r1)!;
    // Age the rotation past the grace window.
    await ctx.sys.updateTable('auth_sessions').set({ rotated_at: new Date(Date.now() - 5 * 60_000) })
      .where('user_id', '=', s.userId).where('rotated_at', 'is not', null).execute();
    const stolen = await refresh(s.cookie);
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().error.code).toBe('session_reused');
    // The legitimate newer token is now dead too.
    expect((await refresh(c1)).statusCode).toBe(401);
  });

  it('requires the anti-CSRF header', async () => {
    const s = await signup(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/refresh', cookies: { kd_rt: s.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('logout revokes the session', async () => {
    const s = await signup(ctx.app);
    const out = await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { 'x-kasadesk-csrf': '1' }, cookies: { kd_rt: s.cookie } });
    expect(out.statusCode).toBe(204);
    expect((await refresh(s.cookie)).statusCode).toBe(401);
  });
});

describe('password reset', () => {
  it('resets the password once and logs out every session', async () => {
    const s = await signup(ctx.app);
    expect((await api(ctx.app).post('/v1/auth/password/forgot', { email: s.email })).statusCode).toBe(202);
    const url = new URL(ctx.notifier.last('password_reset')!.data.url as string);
    const token = url.searchParams.get('token')!;

    expect((await api(ctx.app).post('/v1/auth/password/reset', { token, password: 'brand-new-password' })).statusCode).toBe(204);
    expect((await api(ctx.app).post('/v1/auth/password/reset', { token, password: 'another-password!' })).statusCode).toBe(400);
    expect((await refresh(s.cookie)).statusCode).toBe(401);
    expect((await api(ctx.app).post('/v1/auth/login', { email: s.email, password: s.password })).statusCode).toBe(401);
    expect((await api(ctx.app).post('/v1/auth/login', { email: s.email, password: 'brand-new-password' })).statusCode).toBe(200);
  });

  it('does not reveal whether an email exists', async () => {
    const before = ctx.notifier.sent.length;
    const res = await api(ctx.app).post('/v1/auth/password/forgot', { email: `${uniq()}@nobody.com` });
    expect(res.statusCode).toBe(202);
    expect(ctx.notifier.sent.length).toBe(before);
  });
});

describe('access tokens', () => {
  it('rejects missing, malformed and forged tokens', async () => {
    expect((await api(ctx.app).get('/v1/business')).statusCode).toBe(401);
    expect((await api(ctx.app, 'garbage').get('/v1/business')).statusCode).toBe(401);
    const s = await signup(ctx.app);
    const [h, p] = s.token.split('.');
    expect((await api(ctx.app, `${h}.${p}.forgedsignature`).get('/v1/business')).statusCode).toBe(401);
  });
});
