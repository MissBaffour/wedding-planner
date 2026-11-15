import pino from 'pino';
import { buildApp } from './app.ts';
import { loadConfig } from './platform/config.ts';
import { assertRlsEnforced, createDb } from './platform/db/index.ts';
import { LogNotifier } from './platform/notify.ts';
import { createRedis } from './platform/redis.ts';

const config = loadConfig();
const db = createDb(config.DATABASE_URL, config.DATABASE_POOL_MAX);
await assertRlsEnforced(db);
const redis = createRedis(config.REDIS_URL);

// Real SMS/email notifier arrives in step 6; until then notifications are logged.
const notifier = new LogNotifier(pino({ level: config.LOG_LEVEL, name: 'notifier' }));
if (config.NODE_ENV === 'production') {
  console.warn('WARNING: LogNotifier in production writes reset/invite links to logs. Configure a real notifier (step 6).');
}
const app = await buildApp({ config, db, redis, notifier });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.destroy();
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
