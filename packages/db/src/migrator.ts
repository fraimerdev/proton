import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DbHandle } from './client.ts';

export const MIGRATIONS_FOLDER = `${import.meta.dir}/../drizzle`;

export async function runMigrations(handle: DbHandle): Promise<void> {
  await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
}
