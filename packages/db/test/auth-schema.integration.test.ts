import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { rows } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

async function columnsOf(table: string): Promise<Set<string>> {
  const found = await rows<{ column_name: string }>(handle.client`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  return new Set(found.map((r) => r.column_name));
}

/**
 * Better Auth's schema was transcribed by hand from its documentation because
 * `@better-auth/cli` pulls better-sqlite3, which needs node-gyp and will not
 * install under Bun. These tests are what make that transcription safe: a
 * missing column would otherwise surface as a runtime failure during OAuth,
 * which is the worst possible time to find out.
 */
describe('Better Auth core schema', () => {
  test('the user table has every documented column', async () => {
    const columns = await columnsOf('user');

    for (const column of [
      'id',
      'name',
      'email',
      'emailVerified',
      'image',
      'createdAt',
      'updatedAt',
    ]) {
      expect(columns).toContain(column);
    }
  });

  test('the session table has every documented column', async () => {
    const columns = await columnsOf('session');

    for (const column of [
      'id',
      'userId',
      'token',
      'expiresAt',
      'ipAddress',
      'userAgent',
      'createdAt',
      'updatedAt',
    ]) {
      expect(columns).toContain(column);
    }
  });

  test('the account table has every documented column', async () => {
    const columns = await columnsOf('account');

    for (const column of [
      'id',
      'userId',
      'accountId',
      'providerId',
      'accessToken',
      'refreshToken',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
      'scope',
      'idToken',
      'password',
      'createdAt',
      'updatedAt',
    ]) {
      expect(columns).toContain(column);
    }
  });

  test('the verification table has every documented column', async () => {
    const columns = await columnsOf('verification');

    for (const column of ['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt']) {
      expect(columns).toContain(column);
    }
  });

  /**
   * Better Auth addresses columns by these exact camelCase names. Applying the
   * project's snake_case convention here would break every adapter query.
   */
  test('auth columns are camelCase, unlike the rest of the schema', async () => {
    const authColumns = await columnsOf('account');
    const protonColumns = await columnsOf('guild_modules');

    expect(authColumns).toContain('accessToken');
    expect(authColumns).not.toContain('access_token');
    expect(protonColumns).toContain('schema_version');
  });

  test('the Discord access token column is nullable', async () => {
    const found = await rows<{ is_nullable: string }>(handle.client`
      select is_nullable from information_schema.columns
      where table_name = 'account' and column_name = 'accessToken'
    `);

    // A freshly created account row may exist before tokens are stored.
    expect(found[0]?.is_nullable).toBe('YES');
  });
});
