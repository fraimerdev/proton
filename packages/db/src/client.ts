import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  client: postgres.Sql;
  close(): Promise<void>;
}

/**
 * Open a database handle.
 *
 * postgres.js rather than Bun's built-in SQL client: with `drizzle-orm/bun-sql`,
 * jsonb values are serialised twice — Drizzle stringifies the value and the Bun
 * driver stringifies the result again — so an object lands in Postgres as a
 * jsonb *string scalar* and `payload->>'key'` silently returns null. That would
 * corrupt module config (I5) and audit before/after diffs (I7), which are the
 * two places we can least afford it. See plan deviation D17.
 *
 * One consequence to know about: `drizzle({ client })` mutates the client it is
 * given, replacing postgres.js's serialisers *and* parsers for every timestamp
 * OID with identity functions so Drizzle's own column mappers can own dates.
 * Queries issued through `handle.db` are unaffected — but a raw query on
 * `handle.client` must pass timestamps as ISO strings with an explicit
 * `::timestamptz` cast, and gets Postgres's text rendering back rather than a
 * `Date`. See `scheduled-action-store.ts` for the pattern.
 *
 * Callers own the lifetime and must `close()`.
 */
export function createDb(
  connectionString: string,
  options: postgres.Options<Record<string, never>> = {},
): DbHandle {
  const client = postgres(connectionString, options);
  const db = drizzle({ client, schema });

  return {
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}
