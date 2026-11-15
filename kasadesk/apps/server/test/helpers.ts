import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { buildApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/platform/config.ts';
import { createDb, type DB } from '../src/platform/db/index.ts';
import { MemoryNotifier } from '../src/platform/notify.ts';
import { APP_URL, REDIS_URL, SYSTEM_URL } from './env.ts';

export const TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: APP_URL,
  DATABASE_SYSTEM_URL: SYSTEM_URL,
  REDIS_URL,
  JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
  ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  COOKIE_SECURE: 'false',
  AUTH_RATE_LIMIT_PER_MINUTE: '10000',
  RATE_LIMIT_PER_MINUTE: '10000',
};

export interface TestCtx {
  app: FastifyInstance;
  db: DB;
  sys: DB;
  redis: Redis;
  notifier: MemoryNotifier;
  config: Config;
  close: () => Promise<void>;
}

export async function makeTestApp(overrides: Record<string, string> = {}): Promise<TestCtx> {
  const config = loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
  const db = createDb(config.DATABASE_URL, 5);
  const sys = createDb(config.DATABASE_SYSTEM_URL, 2);
  const redis = new Redis(config.REDIS_URL);
  await redis.flushdb();
  const notifier = new MemoryNotifier();
  const app = await buildApp({ config, db, redis, notifier });
  await app.ready();
  return {
    app, db, sys, redis, notifier, config,
    close: async () => { await app.close(); await db.destroy(); await sys.destroy(); redis.disconnect(); },
  };
}

let seq = 0;
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function refreshCookie(res: LightMyRequestResponse): string | undefined {
  return res.cookies.find((c) => c.name === 'kd_rt')?.value;
}

export interface SignedUp {
  token: string;
  cookie: string;
  userId: string;
  businessId: string;
  email: string;
  password: string;
}

export async function signup(app: FastifyInstance, extra: Record<string, unknown> = {}): Promise<SignedUp> {
  const email = `${uniq('owner')}@example.com`;
  const password = 'correct-horse-battery';
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/signup',
    payload: { businessName: 'Auntie Ama Provisions', fullName: 'Ama Mensah', email, password, phone: `024${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, acceptTerms: true, ...extra },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { token: body.accessToken, cookie: refreshCookie(res)!, userId: body.user.id, businessId: body.businessId, email, password };
}

export function api(app: FastifyInstance, token?: string) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers }),
    post: (url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object }),
    patch: (url: string, payload?: unknown) => app.inject({ method: 'PATCH', url, headers, payload: payload as object }),
    put: (url: string, payload?: unknown) => app.inject({ method: 'PUT', url, headers, payload: payload as object }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers }),
  };
}

/** Invite + accept a new user. Returns the new member's access token. */
export async function addMember(ctx: TestCtx, ownerToken: string, role: 'admin' | 'agent' = 'agent') {
  const email = `${uniq(role)}@example.com`;
  const inv = await api(ctx.app, ownerToken).post('/v1/invitations', { email, role });
  if (inv.statusCode !== 201) return { inviteRes: inv } as const;
  const url = ctx.notifier.last('invitation')!.data.url as string;
  const token = new URL(url).searchParams.get('token')!;
  const acc = await api(ctx.app).post('/v1/invitations/accept', { token, password: 'agent-password-1', fullName: 'Kwame Agent' });
  return { inviteRes: inv, acceptRes: acc, email, accessToken: acc.json().accessToken as string, membershipId: undefined };
}
