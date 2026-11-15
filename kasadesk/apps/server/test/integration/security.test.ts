import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRlsEnforced, createDb } from '../../src/platform/db/index.ts';
import { APP_URL, MIGRATOR_URL, SYSTEM_URL } from '../env.ts';
import { api, makeTestApp, uniq, type TestCtx } from '../helpers.ts';

describe('startup safety check', () => {
  it('accepts the app role and refuses roles that bypass RLS', async () => {
    for (const [url, ok] of [[APP_URL, true], [SYSTEM_URL, false], [MIGRATOR_URL, false]] as const) {
      const db = createDb(url, 1);
      try {
        if (ok) await expect(assertRlsEnforced(db)).resolves.toBeUndefined();
        else await expect(assertRlsEnforced(db)).rejects.toThrow(/kasadesk_app/);
      } finally {
        await db.destroy();
      }
    }
  });
});

describe('HTTP rate limiting', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await makeTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' }); });
  afterAll(async () => ctx.close());

  it('limits auth endpoints per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await api(ctx.app).post('/v1/auth/login', { email: `${uniq()}@x.com`, password: 'whatever-pass' })).statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[3]).toBe(429);
  });

  it('does not leak internals on unknown routes', async () => {
    const res = await api(ctx.app).get('/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});
