import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import type { DB, Tx } from './db/index.ts';
import type { Queues } from './queues.ts';

/**
 * Transactional outbox. Domain code calls emit() inside its tenant transaction;
 * the worker's relay publishes after commit. If Redis is down, rows wait and
 * nothing is lost.
 *
 * Topics:
 *  - 'message.send'       -> BullMQ outbound queue (jobId = message id, deduped)
 *  - 'media.download'     -> BullMQ media queue
 *  - 'templates.sync'     -> BullMQ channels queue
 *  - everything else      -> Redis pub/sub `kd:rt:<businessId>` for realtime clients (step 4)
 */
export type OutboxTopic =
  | 'message.send'
  | 'media.download'
  | 'templates.sync'
  | 'message.created'
  | 'message.updated'
  | 'conversation.updated';

export async function emit(tx: Tx, businessId: string, topic: OutboxTopic, payload: Record<string, unknown>) {
  await tx.insertInto('outbox').values({ business_id: businessId, topic, payload: JSON.stringify(payload) }).execute();
}

export const realtimeChannel = (businessId: string) => `kd:rt:${businessId}`;

/** Publish one batch. Uses the SYSTEM pool (cross-tenant). Safe to run in several workers (SKIP LOCKED). */
export async function relayOutbox(sys: DB, redis: Redis, queues: Queues, batch = 200): Promise<number> {
  return sys.transaction().execute(async (tx) => {
    const rows = await sql<{ id: string; business_id: string; topic: string; payload: Record<string, unknown> }>`
      select id, business_id, topic, payload from outbox
       where published_at is null
       order by id
       limit ${batch}
       for update skip locked`.execute(tx);
    if (!rows.rows.length) return 0;
    for (const r of rows.rows) {
      const p = r.payload;
      switch (r.topic) {
        case 'message.send':
          await queues.outbound.add('send', { businessId: r.business_id, messageId: p.messageId as string }, { jobId: `send-${p.messageId}` });
          break;
        case 'media.download':
          await queues.media.add('download', { businessId: r.business_id, attachmentId: p.attachmentId as string }, { jobId: `media-${p.attachmentId}` });
          break;
        case 'templates.sync':
          await queues.channels.add('templates.sync', { businessId: r.business_id, channelId: p.channelId as string });
          break;
        default:
          await redis.publish(realtimeChannel(r.business_id), JSON.stringify({ topic: r.topic, ...p }));
      }
    }
    await tx.updateTable('outbox').set({ published_at: new Date() })
      .where('id', 'in', rows.rows.map((r) => r.id)).execute();
    return rows.rows.length;
  });
}
