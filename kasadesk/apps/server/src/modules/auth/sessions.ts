import { uuidv7 } from '@kasadesk/shared';
import type { DB } from '../../platform/db/index.ts';
import { randomToken, sha256 } from '../../platform/crypto.ts';
import { Errors } from '../../platform/errors.ts';

const DAY = 86_400_000;

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface RotatedSession {
  refreshToken: string;
  userId: string;
  businessId: string | null;
}

/**
 * Refresh-token sessions with rotation and reuse detection.
 *
 * Every refresh replaces the token. Presenting an already-rotated token means
 * it was stolen or replayed, and the whole family is revoked. EXCEPT within a
 * short grace window: on patchy mobile data the client often sends the
 * refresh, the server rotates, and the response never arrives. The retry with
 * the old token must not log the agent out.
 *
 * auth_sessions is user-scoped (no RLS); only this module touches it.
 */
export class SessionStore {
  constructor(
    private readonly db: DB,
    private readonly ttlDays: number,
    private readonly reuseGraceSeconds: number,
  ) {}

  async create(userId: string, businessId: string | null, meta: SessionMeta, familyId = uuidv7()): Promise<string> {
    const token = randomToken(32);
    await this.db
      .insertInto('auth_sessions')
      .values({
        id: uuidv7(),
        user_id: userId,
        business_id: businessId,
        family_id: familyId,
        token_hash: sha256(token),
        expires_at: new Date(Date.now() + this.ttlDays * DAY),
        ip: meta.ip ?? null,
        user_agent: meta.userAgent?.slice(0, 500) ?? null,
      })
      .execute();
    return token;
  }

  async rotate(token: string, meta: SessionMeta, now = new Date()): Promise<RotatedSession> {
    const s = await this.db
      .selectFrom('auth_sessions')
      .selectAll()
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    if (!s || s.revoked_at) throw Errors.unauthorized('invalid_session');
    if (s.expires_at <= now) throw Errors.unauthorized('session_expired');

    if (s.rotated_at) {
      const age = (now.getTime() - s.rotated_at.getTime()) / 1000;
      if (age > this.reuseGraceSeconds) {
        await this.revokeFamily(s.family_id);
        throw Errors.unauthorized('session_reused');
      }
      // benign retry within grace: fall through and issue another token in the same family
    } else {
      const res = await this.db
        .updateTable('auth_sessions')
        .set({ rotated_at: now })
        .where('id', '=', s.id)
        .where('rotated_at', 'is', null)
        .executeTakeFirst();
      // 0 rows => a concurrent refresh rotated it a moment ago; also benign.
      void res;
    }
    const refreshToken = await this.create(s.user_id, s.business_id, meta, s.family_id);
    return { refreshToken, userId: s.user_id, businessId: s.business_id };
  }

  async revokeByToken(token: string): Promise<void> {
    const s = await this.db
      .selectFrom('auth_sessions')
      .select('family_id')
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    if (s) await this.revokeFamily(s.family_id);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .updateTable('auth_sessions')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Remember the selected business on the live session (used by switch-business). */
  async setBusiness(token: string, businessId: string | null): Promise<void> {
    await this.db
      .updateTable('auth_sessions')
      .set({ business_id: businessId })
      .where('token_hash', '=', sha256(token))
      .where('revoked_at', 'is', null)
      .execute();
  }
}
