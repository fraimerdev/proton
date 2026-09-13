import { describe, expect, test } from 'bun:test';
import type { RuleDefinition } from '@proton/core';
import { createModuleRegistry } from '@proton/modules';

const registry = createModuleRegistry();

const policy = {
  enabled: true,
  requireReason: false,
  publicReplies: false,
  defaultTimeoutDuration: '1h',
  defaultBanDeleteDays: 0,
};

describe('moderation compiles its ladder from a guild’s own config', () => {
  const compile = registry.get('moderation')?.compileRules;

  test('the manifest declares a compiler at all', () => {
    expect(typeof compile).toBe('function');
  });

  test('a guild’s rungs produce a rule each', () => {
    const rules = compile?.({
      ...policy,
      escalationWindow: '7d',
      escalationLadder: [
        { atWarnings: 2, action: 'timeout', duration: '10m' },
        { atWarnings: 4, action: 'kick' },
      ],
    } as Parameters<NonNullable<typeof compile>>[0]) as RuleDefinition[];

    expect(rules).toHaveLength(2);
    expect(rules[0]?.actions[0]?.kind).toBe('timeout');
    expect(rules[1]?.actions[0]?.kind).toBe('kick');
  });

  test('an edited window reaches the compiled condition', () => {
    const rules = compile?.({
      ...policy,
      escalationWindow: '30d',
      escalationLadder: [{ atWarnings: 3, action: 'timeout', duration: '1h' }],
    } as Parameters<NonNullable<typeof compile>>[0]) as RuleDefinition[];

    const rate = rules[0]?.conditions.find((c) => c.kind === 'rate-over-window');
    expect(rate && 'window' in rate ? rate.window : null).toBe('30d');
    expect(rate && 'limit' in rate ? rate.limit : null).toBe(3);
  });

  test('an emptied ladder compiles to no rules, so nothing escalates', () => {
    const rules = compile?.({
      ...policy,
      escalationWindow: '7d',
      escalationLadder: [],
    } as Parameters<NonNullable<typeof compile>>[0]) as RuleDefinition[];

    expect(rules).toEqual([]);
  });
});

describe('cases no longer carries the ladder', () => {
  test('it ships and compiles no rules, so a cases save leaves the rules table alone', () => {
    const cases = registry.get('cases');

    expect(cases?.rules).toBeUndefined();
    expect(cases?.compileRules).toBeUndefined();
  });
});
