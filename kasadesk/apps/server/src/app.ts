import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { uuidv7 } from '@kasadesk/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Config } from './platform/config.ts';
import type { DB } from './platform/db/index.ts';
import { AppError, mapDbError } from './platform/errors.ts';
import { CSRF_HEADER, registerGuard } from './platform/http/guard.ts';
import './platform/http/types.ts';
import type { Notifier } from './platform/notify.ts';
import { CounterLimiter } from './platform/rate-limiter.ts';
import { makeAuthCookies } from './modules/auth/cookies.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { AuthService } from './modules/auth/service.ts';
import { SessionStore } from './modules/auth/sessions.ts';
import { AccessTokens } from './modules/auth/tokens.ts';
import { PlanService } from './modules/billing/plans.ts';
import { billingRoutes } from './modules/billing/routes.ts';
import { InvitationService } from './modules/tenancy/invitations.ts';
import { tenancyRoutes } from './modules/tenancy/routes.ts';
import { TenancyService } from './modules/tenancy/service.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  redis: Redis;
  notifier: Notifier;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, redis, notifier } = deps;

  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    genReqId: () => uuidv7(),
    bodyLimit: 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.token', '*.refreshToken'],
        censor: '[redacted]',
      },
    },
  });

  await app.register(helmet, { contentSecurityPolicy: false }); // JSON API; CSP is set on the PWA host
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', CSRF_HEADER],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'kd:http-rl:',
    // Logged-in users are limited per user; anonymous traffic per IP.
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return h ? `tok:${h.slice(-24)}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests. Retry in ${Math.ceil(ctx.ttl / 1000)}s.` },
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = err instanceof AppError ? err : mapDbError(err);
    if (mapped) {
      return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message, details: mapped.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send(err);
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong.' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }));

  const tokens = new AccessTokens(config.JWT_ACCESS_SECRET, config.JWT_ISSUER, config.ACCESS_TOKEN_TTL_SECONDS);
  const sessions = new SessionStore(db, config.REFRESH_TOKEN_TTL_DAYS, config.REFRESH_REUSE_GRACE_SECONDS);
  const loginFailures = new CounterLimiter(redis, 'login-fail', config.LOGIN_MAX_FAILURES_PER_EMAIL, config.LOGIN_FAILURE_WINDOW_SECONDS);
  const auth = new AuthService({ db, config, tokens, sessions, notifier, loginFailures });
  const tenancy = new TenancyService(db);
  const invitations = new InvitationService({ db, config, notifier, auth });
  const plans = new PlanService(db);

  registerGuard(app, { db, tokens });

  app.get('/healthz', { config: { auth: 'none', rateLimit: false } }, async () => ({ ok: true }));
  authRoutes(app, { auth, config, db });
  tenancyRoutes(app, {
    tenancy, invitations, respondAuth: makeAuthCookies(config).respond,
    authRateLimit: { max: config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
  });
  billingRoutes(app, { plans });

  return app;
}
