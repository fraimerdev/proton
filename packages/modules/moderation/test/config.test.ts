import { describe, expect, test } from 'bun:test';
import { UnsupportedSchemaError, zodToDescriptors } from '@proton/core';
import {
  escalationLadderSchema,
  escalationRungSchema,
  liftStoredConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
  moderationFormSchema,
} from '../src/config.ts';

describe('moderation config', () => {
  test('the default config satisfies its own schema', () => {
    expect(moderationConfigSchema.safeParse(moderationDefaultConfig).success).toBe(true);
  });

  test('an empty object fills in every default', () => {
    expect(moderationConfigSchema.parse({})).toEqual(moderationDefaultConfig);
  });

  test('the ladder round-trips through JSON unchanged', () => {
    const restored = moderationConfigSchema.parse(
      JSON.parse(JSON.stringify(moderationDefaultConfig)),
    );

    expect(restored.escalationLadder).toEqual(moderationDefaultConfig.escalationLadder);
  });

  test('the default ladder escalates without kicking or banning', () => {
    for (const rung of moderationDefaultConfig.escalationLadder) {
      expect(rung.action).toBe('timeout');
    }
  });

  test('a config stored before moderation owned the ladder gets the default one', () => {
    const stored = {
      enabled: true,
      requireReason: true,
      publicReplies: false,
      defaultTimeoutDuration: '15m',
      defaultBanDeleteDays: 1,
    };

    expect(moderationConfigSchema.parse(stored)).toEqual({
      ...stored,
      escalationWindow: '30d',
      escalationLadder: [
        { atWarnings: 3, action: 'timeout', duration: '1h' },
        { atWarnings: 5, action: 'timeout', duration: '1d' },
      ],
    });
  });
});

describe('a save from a page loaded before moderation owned the ladder', () => {
  const policy = {
    enabled: true,
    requireReason: true,
    publicReplies: false,
    defaultTimeoutDuration: '15m',
    defaultBanDeleteDays: 1,
  };

  const current = moderationConfigSchema.parse({
    ...policy,
    escalationWindow: '7d',
    escalationLadder: [{ atWarnings: 2, action: 'kick' }],
  });

  test('keeps the ladder and window the guild already has', () => {
    expect(moderationConfigSchema.parse(liftStoredConfig(policy, current))).toEqual(current);
  });

  test('a page that sends the ladder is taken at its word, even an emptied one', () => {
    const emptied = { ...current, escalationLadder: [] };

    expect(liftStoredConfig(emptied, current)).toBe(emptied);
  });

  test('a stored config is read as it is, with nothing to carry from', () => {
    expect(liftStoredConfig(policy)).toBe(policy);
  });

  test('anything that is not a config object passes through', () => {
    expect(liftStoredConfig(null, current)).toBeNull();
    expect(liftStoredConfig('nonsense', current)).toBe('nonsense');
    expect(liftStoredConfig([1, 2], current)).toEqual([1, 2]);
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
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [{ atWarnings: 3, action: 'timeout' }],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('timeout');
  });

  test('allows a ban with no duration — that is a permanent ban', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [{ atWarnings: 3, action: 'ban' }],
    });

    expect(result.success).toBe(true);
  });

  test('refuses two rungs at the same warning count', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [
        { atWarnings: 3, action: 'kick' },
        { atWarnings: 3, action: 'ban' },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('refuses a ladder that is not ordered by warning count', () => {
    const result = moderationConfigSchema.safeParse({
      escalationLadder: [
        { atWarnings: 5, action: 'ban' },
        { atWarnings: 3, action: 'kick' },
      ],
    });

    expect(result.success).toBe(false);
  });

  test('the refusals are worded exactly as the dashboard repeats them', () => {
    const unordered = escalationLadderSchema.safeParse([
      { atWarnings: 5, action: 'ban' },
      { atWarnings: 3, action: 'kick' },
    ]);
    const bare = escalationLadderSchema.safeParse([{ atWarnings: 3, action: 'timeout' }]);

    expect(unordered.error?.issues.map((i) => i.message)).toEqual([
      'rungs must be ordered by atWarnings, strictly increasing — two rungs at the same warning ' +
        'count would both fire on it.',
    ]);
    expect(bare.error?.issues.map((i) => i.message)).toEqual([
      "a 'timeout' rung needs a duration, e.g. 1h — Discord timeouts are an expiry, not a flag.",
    ]);
  });
});

describe('form generation (PLAN.md §9)', () => {
  test('the full config schema is refused, naming the ladder', () => {
    expect(() => zodToDescriptors(moderationConfigSchema)).toThrow(UnsupportedSchemaError);
    expect(() => zodToDescriptors(moderationConfigSchema)).toThrow(/escalationLadder/);
    expect(() => zodToDescriptors(moderationConfigSchema)).toThrow(/arrays must be flat/);
  });

  test('the form schema generates exactly the fields the dashboard can render', () => {
    const descriptors = zodToDescriptors(moderationFormSchema);

    expect(descriptors.map((d) => [d.path, d.kind])).toEqual([
      ['enabled', 'boolean'],
      ['requireReason', 'boolean'],
      ['publicReplies', 'boolean'],
      ['defaultTimeoutDuration', 'duration'],
      ['defaultBanDeleteDays', 'number'],
      ['escalationWindow', 'duration'],
    ]);
  });

  test('the form schema is the config schema minus the ladder, not a second copy', () => {
    expect(Object.keys(moderationFormSchema.shape)).toEqual(
      Object.keys(moderationConfigSchema.shape).filter((key) => key !== 'escalationLadder'),
    );
  });
});
