import pg from 'pg';
import { migrate } from '../src/platform/db/migrate.ts';
import { ADMIN_URL, MIGRATOR_URL, TEST_DB } from './env.ts';

/** Fresh database per test run: roles (if missing) -> drop/create DB -> all migrations. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    for (const [role, pw, bypass] of [
      ['kasadesk_migrator', 'dev_mig_pw', false],
      ['kasadesk_app', 'dev_app_pw', false],
      ['kasadesk_system', 'dev_sys_pw', true],
    ] as const) {
      const exists = await admin.query('select 1 from pg_roles where rolname = $1', [role]);
      if (!exists.rowCount) {
        await admin.query(`create role ${role} login ${bypass ? 'bypassrls' : 'nobypassrls'} password '${pw}'`);
      }
    }
    await admin.query(`drop database if exists ${TEST_DB} with (force)`);
    await admin.query(`create database ${TEST_DB} owner kasadesk_migrator`);
  } finally {
    await admin.end();
  }
  await migrate(MIGRATOR_URL);
}
