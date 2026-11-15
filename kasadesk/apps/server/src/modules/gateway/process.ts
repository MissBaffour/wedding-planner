import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { withTenant, type DB } from '../../platform/db/index.ts';
import { emit } from '../../platform/outbox.ts';
import type { InboundJob } from '../../platform/queues.ts';
import { applyStatus, ingestInbound } from '../conversations/ingest.ts';
import { parseWhatsAppWebhook } from '../channels/whatsapp/parse.ts';
import { WEBHOOK_PROVIDER } from './routes.ts';

export interface ProcessDeps {
  db: DB;   // RLS-enforced: all tenant writes
  sys: DB;  // system: read raw events, cross-tenant lookups
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

/** Worker: turn one stored webhook event into messages/receipts. Safe to run more than once. */
export async function processWebhookEvent(deps: ProcessDeps, job: InboundJob): Promise<void> {
  const ev = await deps.sys.selectFrom('webhook_events').selectAll()
    .where('provider', '=', job.provider).where('dedupe_key', '=', job.dedupeKey).executeTakeFirst();
  if (!ev || ev.processed_at) return;
  try {
    if (ev.provider === WEBHOOK_PROVIDER.whatsapp || ev.provider === WEBHOOK_PROVIDER.whatsappByo) {
      await processWhatsApp(deps, ev);
    } else {
      deps.log.warn({ provider: ev.provider }, 'no processor for provider');
    }
    await deps.sys.updateTable('webhook_events')
      .set((eb) => ({ processed_at: new Date(), attempts: eb('attempts', '+', 1), last_error: null }))
      .where('id', '=', ev.id).execute();
  } catch (err) {
    await deps.sys.updateTable('webhook_events')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: String((err as Error).message).slice(0, 500) }))
      .where('id', '=', ev.id).execute();
    throw err;
  }
}

interface StoredEvent { provider: string; payload: Record<string, unknown>; business_id: string | null; channel_id: string | null }

async function processWhatsApp(deps: ProcessDeps, ev: StoredEvent) {
  const parsed = parseWhatsAppWebhook(ev.payload);
  const byo = ev.provider === WEBHOOK_PROVIDER.whatsappByo;

  // Route each phone_number_id to its tenant once.
  const routes = new Map<string, { businessId: string; channelId: string } | null>();
  const route = async (phoneNumberId: string) => {
    if (routes.has(phoneNumberId)) return routes.get(phoneNumberId)!;
    let r: { businessId: string; channelId: string } | null = null;
    if (byo) {
      // A BYO app secret only authenticates ITS channel: ignore anything for other numbers.
      const c = await withTenant(deps.db, { businessId: ev.business_id, userId: null }, (tx) =>
        tx.selectFrom('channels').select(['id', 'external_id', 'status']).where('id', '=', ev.channel_id!).executeTakeFirst());
      if (c && c.external_id === phoneNumberId && c.status !== 'disconnected') r = { businessId: ev.business_id!, channelId: c.id };
      else deps.log.warn({ phoneNumberId, channelId: ev.channel_id }, 'byo webhook for a different number ignored');
    } else {
      const res = await sql<{ business_id: string; channel_id: string; status: string; mode: string | null }>`
        select * from resolve_channel_mode('whatsapp', ${phoneNumberId})`.execute(deps.db);
      const c = res.rows[0];
      if (c && c.mode === 'platform' && c.status !== 'disconnected') r = { businessId: c.business_id, channelId: c.channel_id };
      else deps.log.warn({ phoneNumberId }, 'whatsapp webhook for unknown/disconnected number ignored');
    }
    routes.set(phoneNumberId, r);
    return r;
  };

  for (const m of parsed.messages) {
    const r = await route(m.channelExternalId);
    if (!r) continue;
    await withTenant(deps.db, { businessId: r.businessId, userId: null }, (tx) =>
      ingestInbound(tx, r.businessId, { id: r.channelId, type: 'whatsapp' }, m));
  }
  for (const s of parsed.statuses) {
    const r = await route(s.channelExternalId);
    if (!r) continue;
    await withTenant(deps.db, { businessId: r.businessId, userId: null }, (tx) => applyStatus(tx, r.businessId, r.channelId, s));
  }
  // Template approved/rejected/paused: re-sync that WABA's channels from the API (source of truth).
  for (const t of parsed.templateUpdates) {
    const channels = await deps.sys.selectFrom('channels').select(['id', 'business_id', 'config'])
      .where('type', '=', 'whatsapp').where('external_parent_id', '=', t.wabaId).where('status', '=', 'active').execute();
    for (const c of channels) {
      const mode = (c.config as Record<string, unknown>).mode;
      if (byo ? c.id !== ev.channel_id : mode !== 'platform') continue;
      await deps.sys.transaction().execute((tx) => emit(tx, c.business_id, 'templates.sync', { channelId: c.id, reason: t.event }));
    }
  }
}
