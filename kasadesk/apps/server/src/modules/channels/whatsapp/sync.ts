import { uuidv7 } from '@kasadesk/shared';
import type { Keyring } from '../../../platform/crypto.ts';
import { withTenant, type DB } from '../../../platform/db/index.ts';
import type { TemplateSyncJob } from '../../../platform/queues.ts';
import { decryptCredentials } from '../core/repo.ts';
import { WhatsAppClient, type GraphConfig } from './client.ts';

const CATEGORIES = new Set(['marketing', 'utility', 'authentication']);

/** Worker: mirror the WABA's templates into whatsapp_templates (Meta is the source of truth). */
export async function syncTemplates(deps: { db: DB; keyring: Keyring; graph: GraphConfig }, job: TemplateSyncJob) {
  const ctx = { businessId: job.businessId, userId: null };
  const channel = await withTenant(deps.db, ctx, (tx) =>
    tx.selectFrom('channels').selectAll().where('id', '=', job.channelId).executeTakeFirst());
  if (!channel || channel.type !== 'whatsapp' || channel.status !== 'active' || !channel.external_parent_id) return { synced: 0 };

  const client = new WhatsAppClient(deps.graph, decryptCredentials(deps.keyring, channel).accessToken ?? '');
  const remote = await client.listTemplates(channel.external_parent_id);

  return withTenant(deps.db, ctx, async (tx) => {
    const keep: string[] = [];
    for (const t of remote) {
      const category = String(t.category ?? '').toLowerCase();
      if (!t.name || !t.language || !CATEGORIES.has(category)) continue;
      const row = await tx.insertInto('whatsapp_templates')
        .values({
          id: uuidv7(), business_id: job.businessId, channel_id: channel.id, name: t.name, language: t.language,
          category: category as 'marketing', status: String(t.status ?? 'UNKNOWN'), components: JSON.stringify(t.components ?? []),
          provider_template_id: t.id ? String(t.id) : null, rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null,
        })
        .onConflict((oc) => oc.columns(['channel_id', 'name', 'language']).doUpdateSet((eb) => ({
          category: eb.ref('excluded.category'), status: eb.ref('excluded.status'), components: eb.ref('excluded.components'),
          provider_template_id: eb.ref('excluded.provider_template_id'), rejected_reason: eb.ref('excluded.rejected_reason'),
          synced_at: new Date(),
        })))
        .returning('id')
        .executeTakeFirstOrThrow();
      keep.push(row.id);
    }
    let q = tx.deleteFrom('whatsapp_templates').where('channel_id', '=', channel.id);
    if (keep.length) q = q.where('id', 'not in', keep);
    await q.execute();
    return { synced: keep.length };
  });
}
