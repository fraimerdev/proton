import { describe, expect, test } from 'bun:test';
import { remindersConfigSchema, remindersDefaultConfig, resolveDelay } from '../src/config.ts';

const config = remindersDefaultConfig;

describe('remindersConfigSchema', () => {
  test('defaults leave the module off, with a 30s floor and a year of headroom', () => {
    expect(remindersConfigSchema.parse({})).toEqual({
      enabled: false,
      maxDuration: '365d',
      minDuration: '30s',
    });
  });

  test('refuses a floor further ahead than the ceiling, which would refuse every reminder', () => {
    const parsed = remindersConfigSchema.safeParse({ minDuration: '7d', maxDuration: '1d' });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['minDuration']);
  });

  test('accepts a floor equal to the ceiling', () => {
    expect(remindersConfigSchema.safeParse({ minDuration: '1d', maxDuration: '1d' }).success).toBe(
      true,
    );
  });

  test('refuses a bound that is not a duration', () => {
    expect(remindersConfigSchema.safeParse({ maxDuration: 'a while' }).success).toBe(false);
  });
});

describe('resolveDelay', () => {
  test('reads a duration in each unit it accepts', () => {
    expect(resolveDelay('45s', config)).toEqual({ ok: true, ms: 45_000 });
    expect(resolveDelay('2h', config)).toEqual({ ok: true, ms: 7_200_000 });
    expect(resolveDelay('3w', config)).toEqual({ ok: true, ms: 1_814_400_000 });
  });

  test('hands back the parse error rather than a shrug', () => {
    const result = resolveDelay('tomorrow-ish', config);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('not a valid duration');
    expect(result.ok === false && result.humanReason).toContain('30m');
  });

  test('names the lower bound when the reminder is too soon', () => {
    const result = resolveDelay('5s', config);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('soonest');
    expect(result.ok === false && result.humanReason).toContain('30s');
  });

  test('names the upper bound when the reminder is too far ahead', () => {
    const result = resolveDelay('400d', config);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('furthest');
    expect(result.ok === false && result.humanReason).toContain('365d');
  });

  test('accepts a reminder exactly on either bound', () => {
    expect(resolveDelay('30s', config).ok).toBe(true);
    expect(resolveDelay('365d', config).ok).toBe(true);
  });

  test('tells an admin which setting to fix when the bounds are unreadable', () => {
    const result = resolveDelay('2h', { ...config, minDuration: 'soon' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.humanReason).toContain('soon');
    expect(result.ok === false && result.humanReason).toContain('dashboard');
  });
});
