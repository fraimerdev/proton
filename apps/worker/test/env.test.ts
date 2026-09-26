import { describe, expect, test } from 'bun:test';
import { EnvValidationError } from '@proton/core/env';
import { LEGACY_SCOPE_WARNING, loadEnv } from '../src/env.ts';

const BASE = {
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_APPLICATION_ID: '800000000000000001',
  REDIS_URL: 'redis://localhost:6379',
  DATABASE_URL: 'postgres://proton:proton@localhost:5432/proton',
  API_SHARED_SECRET: 'a-shared-secret-of-length',
};

function load(extra: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const env = loadEnv({ ...BASE, ...extra }, (message) => warnings.push(message));
  return { env, warnings };
}

function refusal(extra: Record<string, string | undefined>): string {
  try {
    load(extra);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
  throw new Error('the environment was accepted');
}

describe('COMMAND_REGISTRATION_SCOPE', () => {
  test('defaults to the test guild only', () => {
    const { env } = load({ DISCORD_TEST_GUILD_ID: '900000000000000001' });

    expect(env.COMMAND_REGISTRATION_SCOPE).toBe('guild');
    expect(env.DISCORD_TEST_GUILD_ID).toBe('900000000000000001');
  });

  test('every-guild is accepted without a test guild', () => {
    const { env, warnings } = load({ COMMAND_REGISTRATION_SCOPE: 'every-guild' });

    expect(env.COMMAND_REGISTRATION_SCOPE).toBe('every-guild');
    expect(warnings).toEqual([]);
  });

  test('the old global value reads as every-guild with one warning', () => {
    const { env, warnings } = load({ COMMAND_REGISTRATION_SCOPE: 'global' });

    expect(env.COMMAND_REGISTRATION_SCOPE).toBe('every-guild');
    expect(warnings).toEqual([LEGACY_SCOPE_WARNING]);
  });

  test('an empty test guild line counts as unset', () => {
    const { env } = load({ COMMAND_REGISTRATION_SCOPE: 'every-guild', DISCORD_TEST_GUILD_ID: '' });

    expect(env.DISCORD_TEST_GUILD_ID).toBeUndefined();
  });

  test('guild scope without a test guild refuses to boot', () => {
    expect(refusal({ COMMAND_REGISTRATION_SCOPE: 'guild' })).toContain(
      'guild requires DISCORD_TEST_GUILD_ID',
    );
    expect(refusal({ DISCORD_TEST_GUILD_ID: '' })).toContain(
      'guild requires DISCORD_TEST_GUILD_ID',
    );
  });

  test('every-guild with a test guild set refuses to boot', () => {
    const message = refusal({
      COMMAND_REGISTRATION_SCOPE: 'every-guild',
      DISCORD_TEST_GUILD_ID: '900000000000000001',
    });

    expect(message).toContain('DISCORD_TEST_GUILD_ID is set');
    expect(message).toContain('COMMAND_REGISTRATION_SCOPE');
  });

  test('the legacy alias is held to the same rail', () => {
    expect(
      refusal({
        COMMAND_REGISTRATION_SCOPE: 'global',
        DISCORD_TEST_GUILD_ID: '900000000000000001',
      }),
    ).toContain('DISCORD_TEST_GUILD_ID is set');
  });

  test('an unknown scope is refused by name', () => {
    expect(refusal({ COMMAND_REGISTRATION_SCOPE: 'everywhere' })).toContain(
      'COMMAND_REGISTRATION_SCOPE',
    );
  });
});
