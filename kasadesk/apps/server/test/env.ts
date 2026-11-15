/** Test infrastructure. Override with env vars in CI. */
const host = process.env.TEST_PG_HOST ?? 'localhost';
const port = process.env.TEST_PG_PORT ?? '5432';
export const TEST_DB = process.env.TEST_PG_DATABASE ?? 'kasadesk_test';
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? `postgres://postgres:postgres@${host}:${port}/postgres`;
export const MIGRATOR_URL = `postgres://kasadesk_migrator:dev_mig_pw@${host}:${port}/${TEST_DB}`;
export const APP_URL = `postgres://kasadesk_app:dev_app_pw@${host}:${port}/${TEST_DB}`;
export const SYSTEM_URL = `postgres://kasadesk_system:dev_sys_pw@${host}:${port}/${TEST_DB}`;
export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
