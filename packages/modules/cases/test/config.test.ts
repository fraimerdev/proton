import { describe, expect, test } from 'bun:test';
import { zodToDescriptors } from '@proton/core';
import { casesConfigSchema, casesDefaultConfig } from '../src/config.ts';

describe('cases config', () => {
  test('the default config satisfies its own schema', () => {
    expect(casesConfigSchema.safeParse(casesDefaultConfig).success).toBe(true);
  });

  test('an empty object fills in every default', () => {
    const parsed = casesConfigSchema.parse({});

    expect(parsed).toEqual(casesDefaultConfig);
  });

  test('a config stored with the retired ladder and history limit parses to the switch alone', () => {
    const result = casesConfigSchema.safeParse({
      enabled: false,
      historyLimit: 20,
      escalationWindow: '7d',
      escalationLadder: [
        { atWarnings: 2, action: 'timeout', duration: '10m' },
        { atWarnings: 4, action: 'kick' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ enabled: false });
  });
});

describe('form generation (PLAN.md §9)', () => {
  test('the config schema renders directly, with nothing left to omit', () => {
    expect(zodToDescriptors(casesConfigSchema).map((d) => [d.path, d.kind])).toEqual([
      ['enabled', 'boolean'],
    ]);
  });
});
