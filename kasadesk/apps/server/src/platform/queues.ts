import { Queue, type ConnectionOptions } from 'bullmq';

export const QUEUE = {
  inbound: 'kd-inbound',     // raw webhook events -> normalized messages
  outbound: 'kd-outbound',   // agent/bot messages -> provider APIs
  media: 'kd-media',         // download inbound media into object storage
  channels: 'kd-channels',   // template sync, channel health
  scheduler: 'kd-scheduler', // periodic sweeps
} as const;

export interface InboundJob { provider: string; dedupeKey: string }
export interface OutboundJob { businessId: string; messageId: string }
export interface MediaJob { businessId: string; attachmentId: string }
export interface TemplateSyncJob { businessId: string; channelId: string }

export const OUTBOUND_ATTEMPTS = 6;

export function createQueues(connection: ConnectionOptions, opts: { backoffMs?: number } = {}) {
  const b = (ms: number) => opts.backoffMs ?? ms;
  const defaults = { removeOnComplete: { age: 3600, count: 10_000 }, removeOnFail: { age: 7 * 86_400 } };
  return {
    inbound: new Queue<InboundJob>(QUEUE.inbound, {
      connection, defaultJobOptions: { ...defaults, attempts: 8, backoff: { type: 'exponential', delay: b(2_000) } },
    }),
    outbound: new Queue<OutboundJob>(QUEUE.outbound, {
      connection, defaultJobOptions: { ...defaults, attempts: OUTBOUND_ATTEMPTS, backoff: { type: 'exponential', delay: b(3_000) } },
    }),
    media: new Queue<MediaJob>(QUEUE.media, {
      connection, defaultJobOptions: { ...defaults, attempts: 5, backoff: { type: 'exponential', delay: b(5_000) } },
    }),
    channels: new Queue<TemplateSyncJob>(QUEUE.channels, {
      connection, defaultJobOptions: { ...defaults, attempts: 3, backoff: { type: 'exponential', delay: b(10_000) } },
    }),
  };
}
export type Queues = ReturnType<typeof createQueues>;

export async function closeQueues(q: Queues) {
  await Promise.all(Object.values(q).map((x) => x.close()));
}
