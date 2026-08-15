import { describe, expect, test } from 'bun:test';
import {
  type AntiraidConfig,
  antiraidConfigSchema,
  antiraidDefaultConfig,
  readScoreSettings,
} from '../src/config.ts';
import { MAX_JOIN_SCORE, MIN_ACTIONABLE_SCORE } from '../src/score.ts';

function parse(overrides: Record<string, unknown>) {
  return antiraidConfigSchema.safeParse({ ...antiraidDefaultConfig, ...overrides });
}

function issue(result: ReturnType<typeof parse>): string {
  return result.success ? '' : result.error.issues.map((i) => i.message).join('; ');
}

describe('antiraidConfigSchema', () => {
  test('the shipped default parses and is off until a guild configures it', () => {
    const parsed = antiraidConfigSchema.parse(antiraidDefaultConfig);
    expect(parsed).toEqual(antiraidDefaultConfig);

    expect(parsed.enabled).toBe(false);
    expect(parsed.response).toBe('verify');
  });

  test('an empty object takes every default', () => {
    expect(antiraidConfigSchema.parse({})).toEqual(antiraidDefaultConfig);
  });

  test('a score threshold below the floor is refused', () => {
    const result = parse({ scoreThreshold: MIN_ACTIONABLE_SCORE - 1 });
    expect(result.success).toBe(false);
    expect(parse({ scoreThreshold: MIN_ACTIONABLE_SCORE }).success).toBe(true);
    expect(parse({ scoreThreshold: MAX_JOIN_SCORE }).success).toBe(true);
    expect(parse({ scoreThreshold: MAX_JOIN_SCORE + 1 }).success).toBe(false);
  });

  test('a join threshold of one is refused — one join is not a rate', () => {
    expect(parse({ joinThreshold: 1 }).success).toBe(false);
    expect(parse({ joinThreshold: 2 }).success).toBe(true);
  });

  test('brand new must be a subset of new, and says so on the offending field', () => {
    const result = parse({ newAccountAge: '1d', brandNewAccountAge: '7d' });
    expect(result.success).toBe(false);
    expect(issue(result)).toContain('brand-new accounts are a subset of new ones');
    expect(result.success ? [] : result.error.issues[0]?.path).toEqual(['brandNewAccountAge']);

    expect(parse({ newAccountAge: '7d', brandNewAccountAge: '7d' }).success).toBe(true);
  });

  test('durations must be durations', () => {
    expect(parse({ joinWindow: '10 seconds' }).success).toBe(false);
    expect(parse({ newAccountAge: 'never' }).success).toBe(false);
  });

  test('role and channel ids must be snowflakes', () => {
    expect(parse({ verificationRoleId: 'the-verify-role' }).success).toBe(false);
    expect(parse({ verificationRoleId: '410000000000000002' }).success).toBe(true);
  });
});

describe('readScoreSettings', () => {
  test('converts the authored durations once, for the window and the scorer', () => {
    const parsed = readScoreSettings({
      ...antiraidDefaultConfig,
      joinWindow: '30s',
      newAccountAge: '7d',
      brandNewAccountAge: '1d',
    });

    expect(parsed).toEqual({
      joinWindowMs: 30_000,
      settings: {
        joinThreshold: 10,
        joinWindow: '30s',
        newAccountMs: 7 * 24 * 60 * 60 * 1000,
        brandNewAccountMs: 24 * 60 * 60 * 1000,
      },
    });
  });

  test('a row an older build wrote is named, not thrown', () => {
    const stored = { ...antiraidDefaultConfig, joinWindow: 'a while' } as AntiraidConfig;
    const parsed = readScoreSettings(stored);

    expect('invalid' in parsed).toBe(true);
    if ('invalid' in parsed) {
      expect(parsed.invalid).toContain("joinWindow='a while'");
      expect(parsed.invalid).toContain('Anti-raid page of the Proton dashboard');
    }
  });
});
