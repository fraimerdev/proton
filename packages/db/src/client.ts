import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  client: postgres.Sql;
  close(): Promise<void>;
}

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
