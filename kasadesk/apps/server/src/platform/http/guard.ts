import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { withTenant, type DB } from '../db/index.ts';
import type { MemberRole, SubscriptionStatus } from '../db/schema.ts';
import { Errors } from '../errors.ts';
import type { AccessTokens } from '../../modules/auth/tokens.ts';
import { accessLevel, deriveStatus, isAllowed } from '../../modules/billing/subscription.ts';
import type { AuthState, TenantState } from './types.ts';

export const CSRF_HEADER = 'x-kasadesk-csrf';

/**
 * Runs before every handler:
 *   1. verify the access token            -> 401
 *   2. confirm active membership          -> 403
 *   3. check role                         -> 403
 *   4. check subscription access level    -> 402  (trial/plan enforcement at the API layer)
 */
export function registerGuard(app: FastifyInstance, deps: { db: DB; tokens: AccessTokens }) {
  app.decorateRequest('auth', null);
  app.decorateRequest('tenant', null);

  app.addHook('preHandler', async (req) => {
    if (req.is404) return; // unknown route: let the 404 handler answer
    const cfg = req.routeOptions.config ?? {};
    if (cfg.csrf && req.headers[CSRF_HEADER] !== '1') throw Errors.forbidden('csrf_header_missing');

    const mode = cfg.auth ?? 'tenant';
    if (mode === 'none') return;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw Errors.unauthorized('missing_token');
    const claims = await deps.tokens.verify(header.slice(7));
    req.auth = claims;
    if (mode === 'user') return;

    if (!claims.businessId) throw Errors.forbidden('no_business_selected');
    const t = await loadTenant(deps.db, claims);
    if (!t) throw Errors.forbidden('not_a_member');

    if (cfg.roles && !cfg.roles.includes(t.role)) throw Errors.forbidden('insufficient_role');

    const need = cfg.access ?? (req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write');
    if (!isAllowed(t.accessLevel, need)) {
      throw Errors.paymentRequired(
        t.accessLevel === 'read_only' ? 'subscription_read_only' : 'subscription_paused',
        t.accessLevel === 'read_only'
          ? 'Your subscription has expired. The account is read-only until you pay.'
          : 'Your account is paused. Pay to reactivate it.',
        { status: t.status, accessLevel: t.accessLevel },
      );
    }
    req.tenant = t;
  });
}

export async function loadTenant(db: DB, a: AuthState): Promise<TenantState | null> {
  if (!a.businessId) return null;
  const row = await withTenant(db, { businessId: a.businessId, userId: a.userId }, async (tx) => {
    const r = await sql<{
      membership_id: string;
      role: MemberRole;
      plan_code: string;
      subscription_status: SubscriptionStatus;
      trial_ends_at: Date;
      current_period_end: Date | null;
    }>`
      select m.id as membership_id, m.role, b.plan_code, b.subscription_status, b.trial_ends_at, b.current_period_end
        from memberships m
        join businesses b on b.id = m.business_id
        join users u on u.id = m.user_id
       where m.user_id = ${a.userId}
         and m.business_id = ${a.businessId}
         and m.status = 'active'
         and u.disabled_at is null
         and b.deleted_at is null`.execute(tx);
    return r.rows[0];
  });
  if (!row) return null;
  const status = deriveStatus(row);
  return {
    userId: a.userId,
    businessId: a.businessId,
    membershipId: row.membership_id,
    role: row.role,
    planCode: row.plan_code,
    status,
    accessLevel: accessLevel(status),
  };
}

/** For handlers: the tenant state (guaranteed by the guard on 'tenant' routes). */
export function tenantOf(req: FastifyRequest): TenantState {
  if (!req.tenant) throw Errors.unauthorized();
  return req.tenant;
}

export function authOf(req: FastifyRequest): AuthState {
  if (!req.auth) throw Errors.unauthorized();
  return req.auth;
}

export function requestMeta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}
