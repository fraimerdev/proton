import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DbHandle } from './client.ts';

/** Absolute path to the generated SQL migrations, resolved relative to this file. */
export const MIGRATIONS_FOLDER = `${import.meta.dir}/../drizzle`;

/**
 * Apply all pending migrations. Safe to run repeatedly — drizzle records applied
 * migrations in its own journal table and skips them on re-run.
 */
export async function runMigrations(handle: DbHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}
