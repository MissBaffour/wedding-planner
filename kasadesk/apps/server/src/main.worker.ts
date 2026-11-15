import pino from 'pino';
import { loadConfig } from './platform/config.ts';
import { Keyring } from './platform/crypto.ts';
import { createDb } from './platform/db/index.ts';
import { LogNotifier } from './platform/notify.ts';
import { createRedis } from './platform/redis.ts';
import { createStorage } from './platform/storage.ts';
import { startWorkers } from './worker.ts';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL, config.DATABASE_POOL_MAX);
const sys = createDb(config.DATABASE_SYSTEM_URL, 4);
const connection = createRedis(config.REDIS_URL, { forQueue: true });
const publisher = createRedis(config.REDIS_URL);

const runtime = await startWorkers({
  config, db, sys, connection, publisher, log,
  keyring: Keyring.parse(config.ENCRYPTION_KEYS, config.ENCRYPTION_ACTIVE_KEY_ID),
  storage: createStorage(config),
  notifier: new LogNotifier(log),
});
log.info('worker started');

const shutdown = async () => {
  log.info('worker shutting down');
  await runtime.close();
  await db.destroy();
  await sys.destroy();
  connection.disconnect();
  publisher.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
