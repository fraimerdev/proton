import { describe, expect, test } from 'bun:test';
import { UnsupportedSchemaError, zodToDescriptors } from '@proton/core';
import {
  casesConfigSchema,
  casesDefaultConfig,
  casesFormSchema,
  escalationRungSchema,
} from '../src/config.ts';

describe('cases config', () => {
  test('the default config satisfies its own schema', () => {
    expect(casesConfigSchema.safeParse(casesDefaultConfig).success).toBe(true);
  });

  test('an empty object fills in every default', () => {
    const parsed = casesConfigSchema.parse({});

    expect(parsed).toEqual(casesDefaultConfig);
  });

  test('the ladder round-trips through JSON unchanged', () => {
    const restored = casesConfigSchema.parse(JSON.parse(JSON.stringify(casesDefaultConfig)));

    expect(restored.escalationLadder).toEqual(casesDefaultConfig.escalationLadder);
  });

  test('the default ladder escalates without kicking or banning', () => {
    for (const rung of casesDefaultConfig.escalationLadder) {
      expect(rung.action).toBe('timeout');
    }
  });
});

describe('escalation ladder validation', () => {
  test('accepts a rung the rule engine can actually build', () => {
    expect(
      escalationRungSchema.safeParse({ atWarnings: 3, action: 'timeout', duration: '1h' }).success,
    ).toBe(true);
  });

  test('refuses a rung at one warning, which no rate window can express', () => {
    expect(escalationRungSchema.safeParse({ atWarnings: 1, action: 'kick' }).success).toBe(false);
  });

  test('refuses a timeout with no duration', () => {
    const result = casesConfigSchema.safeParse({
      escalationLadder: [{ atWarnings: 3, action: 'timeout' }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('timeout');
  });

  test('allows a ban with no duration — that is a permanent ban', () => {
    const result = casesConfigSchema.safeParse({
      escalationLadder: [{ atWarnings: 3, action: 'ban' }],
    });

    expect(result.success).toBe(true);
  });

  test('refuses two rungs at the same warning count', () => {
    const result = casesConfigSchema.safeParse({
      escalationLadder: [
        { atWarnings: 3, action: 'kick' },
        { atWarnings: 3, action: 'ban' },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('refuses a ladder that is not ordered by warning count', () => {
    const result = casesConfigSchema.safeParse({
      escalationLadder: [
        { atWarnings: 5, action: 'ban' },
        { atWarnings: 3, action: 'kick' },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe('form generation (PLAN.md §9)', () => {
  test('the full config schema is refused, naming the ladder', () => {
    expect(() => zodToDescriptors(casesConfigSchema)).toThrow(UnsupportedSchemaError);
    expect(() => zodToDescriptors(casesConfigSchema)).toThrow(/escalationLadder/);
    expect(() => zodToDescriptors(casesConfigSchema)).toThrow(/arrays must be flat/);
  });

  test('the form schema generates exactly the fields the dashboard can render', () => {
    const descriptors = zodToDescriptors(casesFormSchema);

    expect(descriptors.map((d) => [d.path, d.kind])).toEqual([
      ['enabled', 'boolean'],
      ['historyLimit', 'number'],
      ['escalationWindow', 'duration'],
    ]);
  });

  test('the form schema is the config schema minus the ladder, not a second copy', () => {
    expect(Object.keys(casesFormSchema.shape)).toEqual(
      Object.keys(casesConfigSchema.shape).filter((key) => key !== 'escalationLadder'),
    );
  });
});
