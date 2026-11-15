import { normalizePhone, uuidv7 } from '@kasadesk/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../platform/audit.ts';
import type { Config } from '../../platform/config.ts';
import { randomToken, sha256 } from '../../platform/crypto.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import type { MemberRole, SubscriptionStatus } from '../../platform/db/schema.ts';
import { Errors } from '../../platform/errors.ts';
import type { Notifier } from '../../platform/notify.ts';
import type { CounterLimiter } from '../../platform/rate-limiter.ts';
import { TRIAL_DAYS } from '../billing/subscription.ts';
import { PASSWORD_MAX, PASSWORD_MIN, dummyVerify, hashPassword, verifyPassword } from './passwords.ts';
import type { SessionMeta, SessionStore } from './sessions.ts';
import type { AccessTokens } from './tokens.ts';

export const TERMS_VERSION = '2026-11';
const DAY = 86_400_000;
const RESET_TTL_MS = 60 * 60 * 1000;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
const phoneSchema = z
  .string()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number, e.g. 024 123 4567' });
    return n ?? '';
  });

export const SignupBody = z.object({
  businessName: z.string().trim().min(2).max(120),
  fullName: z.string().trim().min(2).max(80),
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema.optional(),
  /** Acceptance of Terms + Privacy Notice (Data Protection Act, 2012). */
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the terms to continue' }) }),
});

export const LoginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX),
  businessId: z.string().uuid().optional(),
});

export interface BusinessSummary {
  businessId: string;
  businessName: string;
  role: MemberRole;
  subscriptionStatus: SubscriptionStatus;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; fullName: string };
  businessId: string | null;
  businesses: BusinessSummary[];
}

export interface AuthDeps {
  db: DB;
  config: Config;
  tokens: AccessTokens;
  sessions: SessionStore;
  notifier: Notifier;
  loginFailures: CounterLimiter;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base.length >= 2 ? base : 'biz'}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

export class AuthService {
  constructor(private readonly d: AuthDeps) {}

  async signup(input: z.infer<typeof SignupBody>, meta: SessionMeta): Promise<AuthResult> {
    const existing = await this.lookupUser(input.email);
    if (existing) throw Errors.conflict('email_taken', 'An account with this email already exists. Log in instead.');

    const passwordHash = await hashPassword(input.password);
    const userId = uuidv7();
    const businessId = uuidv7();
    const membershipId = uuidv7();
    const now = Date.now();

    await withTenant(this.d.db, { businessId, userId }, async (tx) => {
      if (input.phone && (await sql<{ taken: boolean }>`select phone_taken(${input.phone}) as taken`.execute(tx)).rows[0]?.taken) {
        throw Errors.conflict('phone_taken', 'This phone number is already used by another KasaDesk account.');
      }
      await tx
        .insertInto('users')
        .values({
          id: userId,
          email: input.email,
          phone_e164: input.phone ?? null,
          password_hash: passwordHash,
          full_name: input.fullName,
        })
        .execute();
      await tx
        .insertInto('businesses')
        .values({
          id: businessId,
          name: input.businessName,
          slug: slugify(input.businessName),
          phone_e164: input.phone ?? null,
          email: input.email,
          billing_email: input.email,
          billing_msisdn: input.phone ?? null,
          trial_ends_at: new Date(now + TRIAL_DAYS * DAY),
        })
        .execute();
      await tx.insertInto('business_settings').values({ business_id: businessId }).execute();
      // Default opening hours: Monday–Saturday 08:00–18:00 (editable).
      await tx
        .insertInto('business_hours')
        .values([1, 2, 3, 4, 5, 6].map((weekday) => ({ business_id: businessId, weekday, opens_at: '08:00', closes_at: '18:00' })))
        .execute();
      await tx
        .insertInto('memberships')
        .values({ id: membershipId, business_id: businessId, user_id: userId, role: 'owner', display_name: input.fullName })
        .execute();
      await audit(tx, { businessId, actorUserId: userId, action: 'business.created', entityType: 'business', entityId: businessId, ...meta });
      await audit(tx, { businessId, actorUserId: userId, action: 'terms.accepted', changes: { version: TERMS_VERSION }, ...meta });
    });

    return this.issue(userId, businessId, meta);
  }

  async login(input: z.infer<typeof LoginBody>, meta: SessionMeta): Promise<AuthResult> {
    const emailKey = sha256(input.email).toString('hex');
    if (await this.d.loginFailures.isBlocked(emailKey)) {
      throw Errors.tooMany('too_many_attempts', 'Too many failed attempts. Try again later or reset your password.');
    }
    const user = await this.lookupUser(input.email);
    const ok = user ? await verifyPassword(user.password_hash, input.password) : await dummyVerify(input.password);
    if (!user || !ok || user.disabled_at) {
      await this.d.loginFailures.hit(emailKey);
      throw Errors.unauthorized('invalid_credentials', 'Email or password is incorrect.');
    }
    await this.d.loginFailures.reset(emailKey);

    const businesses = await this.businessesFor(user.user_id);
    const chosen = input.businessId
      ? businesses.find((b) => b.businessId === input.businessId)?.businessId
      : businesses[0]?.businessId;
    if (input.businessId && !chosen) throw Errors.forbidden('not_a_member');

    await withTenant(this.d.db, { businessId: chosen ?? null, userId: user.user_id }, async (tx) => {
      await tx.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.user_id).execute();
      if (chosen) await audit(tx, { businessId: chosen, actorUserId: user.user_id, action: 'auth.login', ...meta });
    });
    return this.issue(user.user_id, chosen ?? null, meta, businesses);
  }

  async refresh(refreshToken: string, meta: SessionMeta): Promise<AuthResult> {
    const rotated = await this.d.sessions.rotate(refreshToken, meta);
    const user = await this.userById(rotated.userId);
    if (!user || user.disabled_at) {
      await this.d.sessions.revokeAllForUser(rotated.userId);
      throw Errors.unauthorized('invalid_session');
    }
    const businesses = await this.businessesFor(rotated.userId);
    // Membership may have been removed since the session started.
    const businessId = businesses.some((b) => b.businessId === rotated.businessId)
      ? rotated.businessId
      : (businesses[0]?.businessId ?? null);
    if (businessId !== rotated.businessId) await this.d.sessions.setBusiness(rotated.refreshToken, businessId);
    return {
      accessToken: await this.d.tokens.sign({ userId: rotated.userId, businessId }),
      refreshToken: rotated.refreshToken,
      expiresIn: this.d.tokens.ttlSeconds,
      user: { id: user.id, email: user.email, fullName: user.full_name },
      businessId,
      businesses,
    };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.d.sessions.revokeByToken(refreshToken);
  }

  async switchBusiness(userId: string, businessId: string, refreshToken: string | undefined) {
    const businesses = await this.businessesFor(userId);
    if (!businesses.some((b) => b.businessId === businessId)) throw Errors.forbidden('not_a_member');
    if (refreshToken) await this.d.sessions.setBusiness(refreshToken, businessId);
    return { accessToken: await this.d.tokens.sign({ userId, businessId }), expiresIn: this.d.tokens.ttlSeconds, businessId };
  }

  /** Always succeeds from the caller's point of view (no account enumeration). */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.lookupUser(email);
    if (!user || user.disabled_at) return;
    const token = randomToken(32);
    await this.d.db
      .insertInto('password_reset_tokens')
      .values({ id: uuidv7(), user_id: user.user_id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_TTL_MS) })
      .execute();
    await this.d.notifier.send({
      to: { email },
      template: 'password_reset',
      data: { url: `${this.d.config.APP_URL}/reset-password?token=${token}`, expiresInMinutes: RESET_TTL_MS / 60_000 },
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await this.d.db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    if (!row || row.used_at || row.expires_at <= new Date()) throw Errors.badRequest('invalid_reset_token', 'This reset link is invalid or has expired.');
    const passwordHash = await hashPassword(newPassword);
    await withTenant(this.d.db, { businessId: null, userId: row.user_id }, async (tx) => {
      const used = await tx
        .updateTable('password_reset_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', row.id)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      if (Number(used.numUpdatedRows) !== 1) throw Errors.badRequest('invalid_reset_token');
      await tx.updateTable('users').set({ password_hash: passwordHash }).where('id', '=', row.user_id).execute();
    });
    // Log out everywhere after a reset.
    await this.d.sessions.revokeAllForUser(row.user_id);
  }

  // ---- helpers ----

  async issue(userId: string, businessId: string | null, meta: SessionMeta, businesses?: BusinessSummary[]): Promise<AuthResult> {
    const user = await this.userById(userId);
    if (!user) throw Errors.unauthorized();
    const refreshToken = await this.d.sessions.create(userId, businessId, meta);
    return {
      accessToken: await this.d.tokens.sign({ userId, businessId }),
      refreshToken,
      expiresIn: this.d.tokens.ttlSeconds,
      user: { id: user.id, email: user.email, fullName: user.full_name },
      businessId,
      businesses: businesses ?? (await this.businessesFor(userId)),
    };
  }

  async lookupUser(email: string) {
    const r = await sql<{ user_id: string; password_hash: string; disabled_at: Date | null }>`
      select * from auth_lookup_user(${email})`.execute(this.d.db);
    return r.rows[0] ?? null;
  }

  async businessesFor(userId: string): Promise<BusinessSummary[]> {
    const r = await sql<{ business_id: string; business_name: string; role: MemberRole; subscription_status: SubscriptionStatus }>`
      select * from auth_user_businesses(${userId})`.execute(this.d.db);
    return r.rows.map((b) => ({
      businessId: b.business_id,
      businessName: b.business_name,
      role: b.role,
      subscriptionStatus: b.subscription_status,
    }));
  }

  private userById(userId: string) {
    return withTenant(this.d.db, { businessId: null, userId }, (tx) =>
      tx.selectFrom('users').select(['id', 'email', 'full_name', 'disabled_at']).where('id', '=', userId).executeTakeFirst(),
    );
  }
}
