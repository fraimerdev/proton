import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  DEFAULT_AUDIT_REASON,
  DELETE_SECONDS_MAX,
  honeypotConfigSchema,
  liftStoredConfig,
} from '../src/config.ts';
import { LOUNGE, TRAP } from './harness.ts';

function v1(rows: Array<Record<string, unknown>>, rest: Record<string, unknown> = {}) {
  return { enabled: true, includeThreads: true, logChannelId: undefined, channels: rows, ...rest };
}

const SOFTBAN_ROW = {
  channelId: TRAP,
  enabled: true,
  action: 'softban',
  deleteMessageSeconds: DELETE_SECONDS_MAX,
  timeoutDuration: '1h',
};

describe('lifting a v1 config', () => {
  test('moves the single row’s settings up to the module', () => {
    const lifted = liftStoredConfig(
      v1([{ ...SOFTBAN_ROW, action: 'kick', deleteMessageSeconds: 3_600, timeoutDuration: '10m' }]),
    ) as Record<string, unknown>;

    expect(lifted.action).toBe('kick');
    expect(lifted.deleteMessageSeconds).toBe(3_600);
    expect(lifted.timeoutDuration).toBe('10m');
  });

  test('narrows every row to the channel and whether it is armed, in order', () => {
    const lifted = liftStoredConfig(
      v1([SOFTBAN_ROW, { ...SOFTBAN_ROW, channelId: LOUNGE, enabled: false, action: 'ban' }]),
    ) as Record<string, unknown>;

    expect(lifted.channels).toEqual([
      { channelId: TRAP, enabled: true },
      { channelId: LOUNGE, enabled: false },
    ]);
  });

  // Rows that disagreed cannot all be honoured. The first armed one decides, so a guild that
  // parked its odd trap keeps the settings of the trap that was actually running.
  test('the first armed row decides when rows disagree', () => {
    const lifted = liftStoredConfig(
      v1([
        { ...SOFTBAN_ROW, enabled: false, action: 'warn' },
        { ...SOFTBAN_ROW, channelId: LOUNGE, action: 'ban', deleteMessageSeconds: 0 },
      ]),
    ) as Record<string, unknown>;

    expect(lifted.action).toBe('ban');
    expect(lifted.deleteMessageSeconds).toBe(0);
  });

  test('falls back to the first row when none of them is armed', () => {
    const lifted = liftStoredConfig(
      v1([{ ...SOFTBAN_ROW, enabled: false, action: 'timeout', timeoutDuration: '2h' }]),
    ) as Record<string, unknown>;

    expect(lifted.action).toBe('timeout');
    expect(lifted.timeoutDuration).toBe('2h');
  });

  test('never overwrites a key the config already carries at the top level', () => {
    const lifted = liftStoredConfig(
      v1([{ ...SOFTBAN_ROW, action: 'kick' }], { action: 'ban' }),
    ) as Record<string, unknown>;

    expect(lifted.action).toBe('ban');
  });

  test('leaves everything else on the config alone', () => {
    const lifted = liftStoredConfig(
      v1([SOFTBAN_ROW], { logChannelId: LOUNGE, includeThreads: false }),
    ) as Record<string, unknown>;

    expect(lifted.logChannelId).toBe(LOUNGE);
    expect(lifted.includeThreads).toBe(false);
  });

  test('the lifted config parses, and keeps the guild’s traps armed', () => {
    const parsed = honeypotConfigSchema.safeParse(liftStoredConfig(v1([SOFTBAN_ROW])));

    expect(parsed.success).toBe(true);
    expect(parsed.data?.channels).toEqual([{ channelId: TRAP, enabled: true }]);
    expect(parsed.data?.enabled).toBe(true);
    expect(parsed.data?.auditLogReason).toBe(DEFAULT_AUDIT_REASON);
  });
});

// It runs on every read AND every write, so a second pass must be free. Returning the very same
// reference is what keeps a save from looking like a change to anything comparing by identity.
describe('lifting is idempotent', () => {
  test('a config with no v1 row comes back as the same object', () => {
    const already = { enabled: true, channels: [{ channelId: TRAP, enabled: true }] };

    expect(liftStoredConfig(already)).toBe(already);
  });

  test('lifting twice is lifting once', () => {
    const once = liftStoredConfig(v1([SOFTBAN_ROW]));

    expect(liftStoredConfig(once)).toBe(once);
    expect(liftStoredConfig(once)).toEqual(once);
  });

  test('anything that is not an object is handed straight back', () => {
    for (const value of [null, undefined, 4, 'x', []]) {
      expect(liftStoredConfig(value)).toBe(value);
    }
  });

  test('a config with no channels key at all is untouched', () => {
    const bare = { enabled: false };

    expect(liftStoredConfig(bare)).toBe(bare);
  });
});

describe('the channel list survives the lift whatever the rows held', () => {
  test('every (channelId, enabled) pair is preserved, in order', () => {
    const row = fc.record({
      channelId: fc.stringMatching(/^[0-9]{17,19}$/),
      enabled: fc.boolean(),
      action: fc.constantFrom('softban', 'ban', 'kick', 'timeout', 'warn', 'none'),
      deleteMessageSeconds: fc.integer({ min: 0, max: DELETE_SECONDS_MAX }),
      timeoutDuration: fc.constantFrom('1h', '30m', '7d'),
    });

    fc.assert(
      fc.property(fc.array(row, { maxLength: 8 }), (rows) => {
        const lifted = liftStoredConfig(v1(rows)) as { channels: unknown[] };

        expect(lifted.channels).toEqual(
          rows.map((r) => ({ channelId: r.channelId, enabled: r.enabled })),
        );
      }),
      { numRuns: 300 },
    );
  });
});
