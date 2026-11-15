import pino from 'pino';
import { buildApp } from './app.ts';
import { loadConfig } from './platform/config.ts';
import { assertRlsEnforced, createDb } from './platform/db/index.ts';
import { LogNotifier } from './platform/notify.ts';
import { createRedis } from './platform/redis.ts';
import { Keyring } from './platform/crypto.ts';
import { closeQueues, createQueues } from './platform/queues.ts';
import { createStorage } from './platform/storage.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, config.DATABASE_POOL_MAX);
await assertRlsEnforced(db);
const redis = createRedis(config.REDIS_URL);

// Real SMS/email notifier arrives in step 6; until then notifications are logged.
const notifier = new LogNotifier(pino({ level: config.LOG_LEVEL, name: 'notifier' }));
if (config.NODE_ENV === 'production') {
  console.warn('WARNING: LogNotifier in production writes reset/invite links to logs. Configure a real notifier (step 6).');
}
const queueConnection = createRedis(config.REDIS_URL, { forQueue: true });
const queues = createQueues(queueConnection);
const keyring = Keyring.parse(config.ENCRYPTION_KEYS, config.ENCRYPTION_ACTIVE_KEY_ID);
const app = await buildApp({ config, db, redis, notifier, queues, keyring, storage: createStorage(config) });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeQueues(queues);
  await db.destroy();
  redis.disconnect();
  queueConnection.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
