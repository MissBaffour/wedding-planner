import { Redis } from 'ioredis';

export function createRedis(url: string, opts: { forQueue?: boolean } = {}): Redis {
  // BullMQ requires maxRetriesPerRequest = null on its connections.
  return new Redis(url, { maxRetriesPerRequest: opts.forQueue ? null : 3, enableReadyCheck: true });
}
