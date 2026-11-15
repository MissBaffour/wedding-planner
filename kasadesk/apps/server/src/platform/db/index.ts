import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export type DB = Kysely<Database>;
export type Tx = Transaction<Database>;
export type { Database } from './schema.ts';

export function createDb(connectionString: string, max = 10): DB {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export interface TenantContext {
  businessId: string | null;
  userId: string | null;
}

/**
 * Run `fn` in a transaction with the tenant context set. The settings are
 * transaction-local (set_config(..., true)) so a pooled connection never
 * carries one tenant's context into another request.
 */
export async function withTenant<T>(db: DB, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.business_id', ${ctx.businessId ?? ''}, true),
                     set_config('app.user_id', ${ctx.userId ?? ''}, true)`.execute(tx);
    return fn(tx);
  });
}

/**
 * Refuse to start the API with a role that would bypass row-level security
 * (superuser, BYPASSRLS, or the table owner).
 */
export async function assertRlsEnforced(db: DB): Promise<void> {
  const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>`
    select r.rolsuper, r.rolbypassrls,
           exists (select 1 from pg_tables t where t.tablename = 'messages' and t.tableowner = current_user) as owns
      from pg_roles r where r.rolname = current_user`.execute(db);
  const r = rows[0];
  if (!r || r.rolsuper || r.rolbypassrls || r.owns) {
    throw new Error('DATABASE_URL must use the RLS-restricted kasadesk_app role');
  }
}
