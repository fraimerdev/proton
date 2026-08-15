import { describe, expect, test } from 'bun:test';
import { type ActionKind, REVERSAL_OF } from '../../src/actions/kinds.ts';
import { planReversal, reversalIdempotencyKey } from '../../src/actions/reversal.ts';
import type { ActionRequest } from '../../src/actions/types.ts';

const GUILD = '900000000000000001';
const USER = '400000000000000000';
const ROLE = '600000000000000000';
const CHANNEL = '500000000000000000';

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind: 'ban',
    targetId: USER,
    actorId: '100000000000000000',
    dryRun: false,
    idempotencyKey: 'abc',
    expiresAt: new Date('2026-08-14T13:00:00.000Z'),
    ...overrides,
  };
}

/**
 * One valid payload per reversible kind. The drift guard below fails if a new
 * pairing is added to REVERSAL_OF without one, which is the point.
 */
const SAMPLE_PAYLOADS: Partial<Record<ActionKind, unknown>> = {
  ban: { userId: USER, deleteMessageSeconds: 0 },
  timeout: { userId: USER, until: new Date('2026-08-14T13:00:00.000Z') },
  add_role: { userId: USER, roleId: ROLE },
  lockdown: { channelId: CHANNEL, roleId: ROLE, previousAllow: '1024', previousDeny: '2048' },
};

function plan(kind: ActionKind) {
  const result = planReversal(request({ kind, payload: SAMPLE_PAYLOADS[kind] }));
  if ('error' in result) throw new Error(`expected a plan for '${kind}': ${result.error}`);
  return result.plan;
}

describe('planReversal', () => {
  test('ban is undone by an unban of the same user', () => {
    expect(plan('ban')).toEqual({ kind: 'unban', payload: { userId: USER } });
  });

  test('timeout is undone by an untimeout', () => {
    expect(plan('timeout')).toEqual({ kind: 'untimeout', payload: { userId: USER } });
  });

  test('add_role is undone by removing the same role', () => {
    expect(plan('add_role')).toEqual({
      kind: 'remove_role',
      payload: { userId: USER, roleId: ROLE },
    });
  });

  /**
   * R4: unlock restores exactly what lockdown recorded. If this ever became a
   * guess — clearing the overwrite, say — every temp lockdown would silently
   * rewrite the channel's real permissions when it lifted.
   */
  test('unlock restores the overwrite bits lockdown recorded, not a default', () => {
    expect(plan('lockdown')).toEqual({
      kind: 'unlock',
      payload: {
        channelId: CHANNEL,
        roleId: ROLE,
        restoreAllow: '1024',
        restoreDeny: '2048',
      },
    });
  });

  /**
   * Drift guard. REVERSAL_OF declares the pairings; this switch performs them.
   * Adding a pairing without a payload translation would otherwise produce a
   * temp action that schedules nothing and never lifts.
   */
  test('every pairing in REVERSAL_OF has a working payload translation', () => {
    const pairings = Object.entries(REVERSAL_OF) as [ActionKind, ActionKind][];
    expect(pairings.length).toBeGreaterThan(0);

    for (const [original, reversal] of pairings) {
      expect(SAMPLE_PAYLOADS[original]).toBeDefined();
      expect(plan(original).kind).toBe(reversal);
    }
  });

  /**
   * The plan is stored as JSONB and read back by another process, so a `Date`
   * that survived the translation would come back as a string the payload schema
   * then rejects — a temp timeout that could never be lifted.
   */
  test('no plan carries a value that JSON cannot round-trip', () => {
    for (const original of Object.keys(REVERSAL_OF) as ActionKind[]) {
      const { payload } = plan(original);
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    }
  });

  test('a kind with no reversal is refused, and the message names it', () => {
    const result = planReversal(request({ kind: 'kick', payload: { userId: USER } }));

    expect('error' in result).toBe(true);
    expect('error' in result && result.error).toContain("'kick'");
  });

  test('a payload the original action never had is refused rather than guessed', () => {
    const result = planReversal(request({ kind: 'ban', payload: { nope: true } }));

    expect('error' in result).toBe(true);
  });
});

describe('reversalIdempotencyKey', () => {
  test('derives deterministically from the original key', () => {
    expect(reversalIdempotencyKey('01JABC')).toBe('reversal:01JABC');
    expect(reversalIdempotencyKey('01JABC')).toBe(reversalIdempotencyKey('01JABC'));
  });

  test('is distinct from the key it derives from', () => {
    // Sharing the key would make the reversal look like a duplicate of the ban
    // and it would be skipped — the ban would never lift.
    expect(reversalIdempotencyKey('01JABC')).not.toBe('01JABC');
  });
});
