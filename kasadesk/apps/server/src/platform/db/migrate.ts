import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../db/migrations');

/**
 * Applies db/migrations/*.sql in name order. Each file wraps itself in
 * BEGIN/COMMIT and records its own version in schema_migrations, so the
 * same files work with plain psql (docker initdb, verify.sh).
 */
export async function migrate(connectionString: string, dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Serialize concurrent deploys.
    await client.query("select pg_advisory_lock(hashtext('kasadesk:migrate'))");
    const exists = await client.query("select to_regclass('public.schema_migrations') is not null as ok");
    const applied = new Set<string>();
    if (exists.rows[0].ok) {
      const r = await client.query<{ version: string }>('select version from schema_migrations');
      r.rows.forEach((row) => applied.add(row.version));
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      log(`applying ${file}`);
      await client.query(await readFile(path.join(dir, file), 'utf8'));
      ran.push(version);
    }
    return ran;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('kasadesk:migrate'))").catch(() => {});
    await client.end();
  }
}
