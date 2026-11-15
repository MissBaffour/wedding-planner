import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import { loadConfig } from './platform/config.ts';
import { createDb } from './platform/db/index.ts';
import { LogNotifier } from './platform/notify.ts';
import { createRedis } from './platform/redis.ts';
import { runSubscriptionSweep } from './modules/billing/sweep.ts';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
// Cross-tenant maintenance uses the BYPASSRLS system role. Tenant-scoped jobs (later steps) use DATABASE_URL.
const sys = createDb(config.DATABASE_SYSTEM_URL, 4);
const connection = createRedis(config.REDIS_URL, { forQueue: true });
const notifier = new LogNotifier(log);

const QUEUE = 'kd-scheduler';
const queue = new Queue(QUEUE, { connection });
// Repeatable job: a single schedule no matter how many workers run.
await queue.upsertJobScheduler('subscription-sweep', { every: 10 * 60_000 }, { name: 'subscription-sweep' });

const worker = new Worker(
  QUEUE,
  async (job) => {
    if (job.name === 'subscription-sweep') {
      const r = await runSubscriptionSweep(sys, notifier);
      log.info({ transitions: r.transitions.length, reminders: r.reminders.length, sessionsPurged: r.sessionsPurged }, 'subscription sweep done');
      return r;
    }
    throw new Error(`unknown job ${job.name}`);
  },
  { connection, concurrency: 1 },
);
worker.on('failed', (job, err) => log.error({ job: job?.name, err }, 'job failed'));
log.info('worker started');

const shutdown = async () => {
  await worker.close();
  await queue.close();
  await sys.destroy();
  connection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
