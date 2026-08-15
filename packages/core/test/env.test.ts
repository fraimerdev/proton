import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createEnv, EnvValidationError } from '../src/env.ts';

const schema = z.object({
  DATABASE_URL: z.url(),
  DISCORD_BOT_TOKEN: z.string().min(50),
  REDIS_DB_BUS: z.coerce.number().int().min(0).max(15),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const VALID = {
  DATABASE_URL: 'postgres://proton:proton@localhost:5432/proton',
  DISCORD_BOT_TOKEN: 'x'.repeat(60),
  REDIS_DB_BUS: '0',
};

describe('createEnv', () => {
  test('parses a valid environment and applies declared defaults', () => {
    const env = createEnv('test', schema, VALID);

    expect(env.DATABASE_URL).toBe('postgres://proton:proton@localhost:5432/proton');
    expect(env.LOG_LEVEL).toBe('info');
  });

  test('coerces numeric strings to numbers', () => {
    const env = createEnv('test', schema, { ...VALID, REDIS_DB_BUS: '4' });

    expect(env.REDIS_DB_BUS).toBe(4);
    expect(typeof env.REDIS_DB_BUS).toBe('number');
  });

  test('strips variables the schema does not declare', () => {
    const env = createEnv('test', schema, { ...VALID, UNRELATED_SECRET: 'leak-me' });

    expect(env).not.toHaveProperty('UNRELATED_SECRET');
  });

  test('throws EnvValidationError naming every missing variable', () => {
    expect(() => createEnv('gateway', schema, {})).toThrow(EnvValidationError);

    try {
      createEnv('gateway', schema, {});
      throw new Error('expected createEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { message, issues } = error as EnvValidationError;

      expect(message).toContain('gateway');

      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('DISCORD_BOT_TOKEN');
      expect(message).toContain('REDIS_DB_BUS');
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('never leaks the offending value into the error message', () => {
    const secret = 'ODk1NzMyMTQ0.GxYzAb.dont-log-me';

    try {
      createEnv('worker', schema, { ...VALID, DISCORD_BOT_TOKEN: secret });
      throw new Error('expected createEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { message, issues } = error as EnvValidationError;

      expect(message).toContain('DISCORD_BOT_TOKEN');
      expect(message).not.toContain(secret);
      expect(issues.join('\n')).not.toContain(secret);
    }
  });

  test('reports the failing key for a malformed value without echoing it', () => {
    try {
      createEnv('api', schema, { ...VALID, DATABASE_URL: 'not-a-url' });
      throw new Error('expected createEnv to throw');
    } catch (error) {
      const { message } = error as EnvValidationError;

      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('not-a-url');
    }
  });
});
