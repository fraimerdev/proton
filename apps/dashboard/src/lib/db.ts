import { createDb } from '@proton/db';
import { loadEnv } from './env.ts';

// One pool for the process. createDb opens a postgres.js pool, so building and closing one per
// call pays a connection handshake on every server function that reads the account table.
export const { db } = createDb(loadEnv().DATABASE_URL);
