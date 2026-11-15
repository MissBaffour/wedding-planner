import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { Config } from './platform/config.ts';
import type { Keyring } from './platform/crypto.ts';
import type { DB } from './platform/db/index.ts';
import type { Notifier } from './platform/notify.ts';
import { relayOutbox } from './platform/outbox.ts';
import { OUTBOUND_ATTEMPTS, QUEUE, createQueues, closeQueues, type InboundJob, type MediaJob, type OutboundJob, type TemplateSyncJob } from './platform/queues.ts';
import type { ObjectStorage } from './platform/storage.ts';
import { runSubscriptionSweep } from './modules/billing/sweep.ts';
import type { ChannelAdapter } from './modules/channels/core/types.ts';
import { WebchatAdapter } from './modules/channels/webchat/adapter.ts';
import { WhatsAppAdapter } from './modules/channels/whatsapp/adapter.ts';
import type { GraphConfig } from './modules/channels/whatsapp/client.ts';
import { syncTemplates } from './modules/channels/whatsapp/sync.ts';
import { processWebhookEvent } from './modules/gateway/process.ts';
import { SEND_LEASE_SECONDS, dispatchMessage } from './modules/messaging/dispatch.ts';
import { downloadAttachment } from './modules/media/service.ts';

export interface WorkerDeps {
  config: Config;
  db: DB;          // kasadesk_app (RLS)
  sys: DB;         // kasadesk_system (cross-tenant)
  connection: ConnectionOptions; // BullMQ redis connection (maxRetriesPerRequest: null)
  publisher: Redis;              // realtime pub/sub
  keyring: Keyring;
  storage: ObjectStorage;
  notifier: Notifier;
  log: Logger;
  outboxIntervalMs?: number;
  schedules?: boolean;           // repeatable jobs (off in tests)
  backoffMs?: number;            // override retry backoff (tests)
}

export function graphConfig(c: Config): GraphConfig {
  return { baseUrl: c.META_GRAPH_BASE_URL, version: c.META_GRAPH_VERSION };
}

/**
 * Recovery sweep: anything that should be in a queue but is not (Redis restart,
 * crashed worker) gets re-enqueued. All jobs are idempotent, so duplicates are harmless.
 */
export async function runRecoverySweep(sys: DB, queues: ReturnType<typeof createQueues>) {
  const events = await sys.selectFrom('webhook_events').select(['provider', 'dedupe_key'])
    .where('processed_at', 'is', null).where('attempts', '<', 10)
    .where('received_at', '<', sql<Date>`now() - interval '1 minute'`).limit(500).execute();
  for (const e of events) {
    await queues.inbound.add('event', { provider: e.provider, dedupeKey: e.dedupe_key }, { jobId: `wh-${e.provider}-${e.dedupe_key}-r${Date.now()}` });
  }
  const stuck = await sys.selectFrom('messages').select(['id', 'business_id'])
    .where('direction', '=', 'outbound')
    .where((eb) => eb.or([
      eb.and([eb('status', '=', 'queued'), eb('created_at', '<', sql<Date>`now() - interval '2 minutes'`), eb('attempts', '=', 0)]),
      eb.and([eb('status', '=', 'sending'), eb('claimed_at', '<', sql<Date>`now() - make_interval(secs => ${SEND_LEASE_SECONDS})`)]),
    ]))
    .limit(500).execute();
  for (const m of stuck) {
    await queues.outbound.add('send', { businessId: m.business_id, messageId: m.id }, { jobId: `send-${m.id}-r${Date.now()}` });
  }
  return { events: events.length, messages: stuck.length };
}

export async function startWorkers(d: WorkerDeps) {
  const queues = createQueues(d.connection, { backoffMs: d.backoffMs });
  const graph = graphConfig(d.config);
  const adapters: Partial<Record<string, ChannelAdapter>> = { whatsapp: new WhatsAppAdapter(graph), webchat: new WebchatAdapter() };
  const media = { db: d.db, keyring: d.keyring, storage: d.storage, graph, config: d.config };
  const opts = { connection: d.connection };

  const workers = [
    new Worker<InboundJob>(QUEUE.inbound, (job) => processWebhookEvent({ db: d.db, sys: d.sys, log: d.log }, job.data), { ...opts, concurrency: 8 }),
    new Worker<OutboundJob>(QUEUE.outbound, async (job) => {
      const isLast = job.attemptsMade + 1 >= (job.opts.attempts ?? OUTBOUND_ATTEMPTS);
      return dispatchMessage({ db: d.db, keyring: d.keyring, adapters }, job.data, isLast);
    }, { ...opts, concurrency: 16 }),
    new Worker<MediaJob>(QUEUE.media, (job) => downloadAttachment(media, job.data), { ...opts, concurrency: 4 }),
    new Worker<TemplateSyncJob>(QUEUE.channels, (job) => syncTemplates({ db: d.db, keyring: d.keyring, graph }, job.data), { ...opts, concurrency: 2 }),
    new Worker(QUEUE.scheduler, async (job) => {
      if (job.name === 'subscription-sweep') return runSubscriptionSweep(d.sys, d.notifier);
      if (job.name === 'recovery-sweep') return runRecoverySweep(d.sys, queues);
      throw new Error(`unknown scheduler job ${job.name}`);
    }, { ...opts, concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => d.log.warn({ queue: w.name, job: job?.name, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  }

  let scheduler: Queue | null = null;
  if (d.schedules !== false) {
    scheduler = new Queue(QUEUE.scheduler, opts);
    await scheduler.upsertJobScheduler('subscription-sweep', { every: 10 * 60_000 }, { name: 'subscription-sweep' });
    await scheduler.upsertJobScheduler('recovery-sweep', { every: 60_000 }, { name: 'recovery-sweep' });
  }

  // Outbox relay loop (no overlap; several worker processes are fine thanks to SKIP LOCKED).
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    running = relayOutbox(d.sys, d.publisher, queues)
      .catch((err) => d.log.error({ err }, 'outbox relay failed'))
      .finally(() => { if (!stopped) timer = setTimeout(tick, d.outboxIntervalMs ?? 250); });
  };
  let timer: NodeJS.Timeout = setTimeout(tick, 0);

  return {
    queues,
    async close() {
      stopped = true;
      clearTimeout(timer);
      await running;
      await Promise.all(workers.map((w) => w.close()));
      await scheduler?.close();
      await closeQueues(queues);
    },
  };
}
