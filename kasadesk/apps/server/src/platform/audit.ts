import type { Tx } from './db/index.ts';

export interface AuditEntry {
  businessId: string;
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'api';
  action: string;
  entityType?: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Append-only audit trail. Never put secrets or message bodies in `changes`. */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx
    .insertInto('audit_logs')
    .values({
      business_id: e.businessId,
      actor_type: e.actorType ?? (e.actorUserId ? 'user' : 'system'),
      actor_user_id: e.actorUserId ?? null,
      action: e.action,
      entity_type: e.entityType ?? null,
      entity_id: e.entityId ?? null,
      changes: JSON.stringify(e.changes ?? {}),
      ip: e.ip ?? null,
      user_agent: e.userAgent?.slice(0, 500) ?? null,
    })
    .execute();
}
