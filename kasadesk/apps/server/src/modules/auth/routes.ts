import type { FastifyInstance } from 'fastify';
import { makeAuthCookies } from './cookies.ts';
import { z } from 'zod';
import type { Config } from '../../platform/config.ts';
import { authOf, loadTenant, requestMeta } from '../../platform/http/guard.ts';
import { parse } from '../../platform/http/validate.ts';
import { Errors } from '../../platform/errors.ts';
import { LoginBody, SignupBody, emailSchema, passwordSchema, type AuthService } from './service.ts';
import { timeline, daysLeft } from '../billing/subscription.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';

export function authRoutes(app: FastifyInstance, deps: { auth: AuthService; config: Config; db: DB }) {
  const { auth, config } = deps;
  const authLimit = { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' };
  const cookies = makeAuthCookies(config);
  const respond = cookies.respond;
  const clearCookie = cookies.clear;
  const cookieOf = cookies.read;

  app.post('/v1/auth/signup', { config: { auth: 'none', rateLimit: authLimit } }, async (req, reply) =>
    respond(reply, await auth.signup(parse(SignupBody, req.body), requestMeta(req)), 201),
  );

  app.post('/v1/auth/login', { config: { auth: 'none', rateLimit: authLimit } }, async (req, reply) =>
    respond(reply, await auth.login(parse(LoginBody, req.body), requestMeta(req))),
  );

  app.post('/v1/auth/refresh', { config: { auth: 'none', csrf: true } }, async (req, reply) => {
    const token = cookieOf(req);
    if (!token) throw Errors.unauthorized('missing_session');
    try {
      return respond(reply, await auth.refresh(token, requestMeta(req)));
    } catch (err) {
      clearCookie(reply);
      throw err;
    }
  });

  app.post('/v1/auth/logout', { config: { auth: 'none', csrf: true } }, async (req, reply) => {
    await auth.logout(cookieOf(req));
    clearCookie(reply);
    return reply.status(204).send();
  });

  app.post('/v1/auth/switch-business', { config: { auth: 'user', csrf: true } }, async (req) => {
    const body = parse(z.object({ businessId: z.string().uuid() }), req.body);
    return auth.switchBusiness(authOf(req).userId, body.businessId, cookieOf(req));
  });

  app.post('/v1/auth/password/forgot', { config: { auth: 'none', rateLimit: authLimit } }, async (req, reply) => {
    const body = parse(z.object({ email: emailSchema }), req.body);
    await auth.forgotPassword(body.email);
    return reply.status(202).send({ ok: true });
  });

  app.post('/v1/auth/password/reset', { config: { auth: 'none', rateLimit: authLimit } }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(200), password: passwordSchema }), req.body);
    await auth.resetPassword(body.token, body.password);
    return reply.status(204).send();
  });

  /** Who am I, which businesses can I open, and what is the state of the current one. */
  app.get('/v1/me', { config: { auth: 'user' } }, async (req) => {
    const a = authOf(req);
    const businesses = await auth.businessesFor(a.userId);
    const tenant = await loadTenant(deps.db, a);
    let current = null;
    if (tenant) {
      const b = await withTenant(deps.db, { businessId: tenant.businessId, userId: a.userId }, (tx) =>
        tx
          .selectFrom('businesses')
          .innerJoin('plans', 'plans.code', 'businesses.plan_code')
          .select([
            'businesses.id', 'businesses.name', 'businesses.subscription_status', 'businesses.trial_ends_at',
            'businesses.current_period_end', 'plans.code as plan_code', 'plans.name as plan_name', 'plans.max_agents',
          ])
          .executeTakeFirstOrThrow(),
      );
      const t = timeline(b);
      current = {
        businessId: b.id,
        name: b.name,
        role: tenant.role,
        membershipId: tenant.membershipId,
        plan: { code: b.plan_code, name: b.plan_name, maxAgents: b.max_agents },
        subscription: {
          status: t.status,
          accessLevel: tenant.accessLevel,
          trialEndsAt: b.current_period_end ? null : b.trial_ends_at,
          currentPeriodEnd: b.current_period_end,
          graceEndsAt: t.graceEndsAt,
          fullAccessEndsAt: t.fullAccessEndsAt,
          readOnlyEndsAt: t.readOnlyEndsAt,
          daysLeft: daysLeft(t.status === 'read_only' ? t.readOnlyEndsAt : t.fullAccessEndsAt),
        },
      };
    }
    return { userId: a.userId, businesses, current };
  });
}
