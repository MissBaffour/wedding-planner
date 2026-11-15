import { uuidv7 } from '@kasadesk/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../platform/audit.ts';
import type { Config } from '../../platform/config.ts';
import { randomToken, sha256 } from '../../platform/crypto.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import type { MemberRole } from '../../platform/db/schema.ts';
import { Errors, mapDbError } from '../../platform/errors.ts';
import type { TenantState } from '../../platform/http/types.ts';
import type { Notifier } from '../../platform/notify.ts';
import { emailSchema, passwordSchema, type AuthService } from '../auth/service.ts';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import type { SessionMeta } from '../auth/sessions.ts';

const INVITE_TTL_MS = 7 * 86_400_000;

export const CreateInvitationBody = z.object({
  email: emailSchema,
  role: z.enum(['admin', 'agent']).default('agent'),
});

export const AcceptInvitationBody = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
  /** Required only when the invited email has no KasaDesk account yet. */
  fullName: z.string().trim().min(2).max(80).optional(),
});

export class InvitationService {
  constructor(
    private readonly d: { db: DB; config: Config; notifier: Notifier; auth: AuthService },
  ) {}

  async create(t: TenantState, input: z.infer<typeof CreateInvitationBody>, meta: SessionMeta) {
    if (input.role === 'admin' && t.role !== 'owner') throw Errors.forbidden('only_owner_can_invite_admins');
    const token = randomToken(32);

    const inv = await withTenant(this.d.db, t, async (tx) => {
      // Friendly early seat check (the DB trigger is the final word when the invite is accepted).
      const r = await sql<{ max_agents: number; active: string; pending: string }>`
        select p.max_agents,
               (select count(*) from memberships m where m.status = 'active') as active,
               (select count(*) from invitations i where i.accepted_at is null and i.expires_at > now()) as pending
          from businesses b join plans p on p.code = b.plan_code`.execute(tx);
      const s = r.rows[0]!;
      if (Number(s.active) + Number(s.pending) >= s.max_agents) {
        throw Errors.paymentRequired('seat_limit_reached', 'All seats on your plan are used or already invited.', {
          maxAgents: s.max_agents, active: Number(s.active), pending: Number(s.pending),
        });
      }
      const existingMember = await sql<{ n: string }>`
        select count(*) as n from memberships m join users u on u.id = m.user_id where u.email = ${input.email}`.execute(tx);
      if (Number(existingMember.rows[0]!.n) > 0) throw Errors.conflict('already_member', 'This person is already a member.');

      // Replace an expired pending invite for the same email.
      await tx.deleteFrom('invitations').where('email', '=', input.email).where('accepted_at', 'is', null)
        .where('expires_at', '<=', new Date()).execute();
      const id = uuidv7();
      try {
        await tx.insertInto('invitations').values({
          id, business_id: t.businessId, email: input.email, role: input.role,
          token_hash: sha256(token), invited_by: t.membershipId, expires_at: new Date(Date.now() + INVITE_TTL_MS),
        }).execute();
      } catch (err) {
        const mapped = mapDbError(err);
        if (mapped?.status === 409) throw Errors.conflict('already_invited', 'This email already has a pending invitation.');
        throw err;
      }
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'invitation.created', entityType: 'invitation', entityId: id, changes: { email: input.email, role: input.role }, ...meta });
      const b = await tx.selectFrom('businesses').select('name').executeTakeFirstOrThrow();
      return { id, businessName: b.name };
    });

    await this.d.notifier.send({
      to: { email: input.email },
      template: 'invitation',
      data: { businessName: inv.businessName, role: input.role, url: `${this.d.config.APP_URL}/invite?token=${token}` },
    });
    return { id: inv.id, email: input.email, role: input.role };
  }

  list(t: TenantState) {
    return withTenant(this.d.db, t, (tx) =>
      tx.selectFrom('invitations').select(['id', 'email', 'role', 'expires_at', 'accepted_at', 'created_at'])
        .where('accepted_at', 'is', null).orderBy('created_at', 'desc').execute(),
    );
  }

  async revoke(t: TenantState, id: string, meta: SessionMeta) {
    await withTenant(this.d.db, t, async (tx) => {
      const r = await tx.deleteFrom('invitations').where('id', '=', id).where('accepted_at', 'is', null).executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw Errors.notFound();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'invitation.revoked', entityType: 'invitation', entityId: id, ...meta });
    });
  }

  /** Public: the invitee accepts with the emailed token (new or existing KasaDesk user). */
  async accept(input: z.infer<typeof AcceptInvitationBody>, meta: SessionMeta) {
    const r = await sql<{ invitation_id: string; business_id: string; email: string; role: MemberRole; expires_at: Date; accepted_at: Date | null }>`
      select * from auth_find_invitation(${sha256(input.token)})`.execute(this.d.db);
    const inv = r.rows[0];
    if (!inv || inv.accepted_at || inv.expires_at <= new Date()) {
      throw Errors.badRequest('invalid_invitation', 'This invitation is invalid or has expired.');
    }

    const existing = await this.d.auth.lookupUser(inv.email);
    let userId: string;
    if (existing) {
      // Prove ownership of the existing account.
      if (existing.disabled_at || !(await verifyPassword(existing.password_hash, input.password))) {
        throw Errors.unauthorized('invalid_credentials', 'Enter the password of your existing KasaDesk account.');
      }
      userId = existing.user_id;
    } else {
      if (!input.fullName) throw Errors.badRequest('validation_failed', 'Full name is required.', [{ path: 'fullName', message: 'Required' }]);
      userId = uuidv7();
      const passwordHash = await hashPassword(input.password);
      await withTenant(this.d.db, { businessId: null, userId }, (tx) =>
        tx.insertInto('users').values({ id: userId, email: inv.email, password_hash: passwordHash, full_name: input.fullName!, email_verified_at: new Date() }).execute(),
      );
    }

    await withTenant(this.d.db, { businessId: inv.business_id, userId }, async (tx) => {
      const marked = await tx.updateTable('invitations').set({ accepted_at: new Date() })
        .where('id', '=', inv.invitation_id).where('accepted_at', 'is', null).executeTakeFirst();
      if (Number(marked.numUpdatedRows) !== 1) throw Errors.badRequest('invalid_invitation');
      const membershipId = uuidv7();
      try {
        await tx.insertInto('memberships').values({
          id: membershipId, business_id: inv.business_id, user_id: userId, role: inv.role,
          display_name: existing ? null : input.fullName ?? null,
        }).execute();
      } catch (err) {
        const mapped = mapDbError(err);
        if (mapped?.code === 'conflict') throw Errors.conflict('already_member');
        throw mapped ?? err;
      }
      await audit(tx, { businessId: inv.business_id, actorUserId: userId, action: 'member.joined', entityType: 'membership', entityId: membershipId, changes: { role: inv.role }, ...meta });
    });

    return this.d.auth.issue(userId, inv.business_id, meta);
  }
}
