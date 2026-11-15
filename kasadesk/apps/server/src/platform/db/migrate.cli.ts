import { migrate } from './migrate.ts';

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  console.error('DATABASE_MIGRATOR_URL is required');
  process.exit(1);
}
const ran = await migrate(url, process.env.MIGRATIONS_DIR, console.log);
console.log(ran.length ? `applied: ${ran.join(', ')}` : 'database is up to date');
