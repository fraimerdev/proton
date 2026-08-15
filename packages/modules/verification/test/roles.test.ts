import { describe, expect, test } from 'bun:test';
import type { GuildRole, GuildState } from '@proton/core';
import { checkGrantable, planQuarantine, planRelease } from '../src/roles.ts';
import type { QuarantineRecord } from '../src/store.ts';

const GUILD = '900000000000000001';
const BOT_ROLE = '410000000000000006';

function state(positions: Record<string, number>, botRoleIds = [BOT_ROLE]): GuildState {
  const roles = new Map<string, GuildRole>(
    Object.entries(positions).map(([id, position]) => [id, { id, permissions: 0n, position }]),
  );
  return {
    guildId: GUILD,
    ownerId: '200000000000000001',
    everyoneRoleId: GUILD,
    roles,
    botRoleIds,
    channels: new Map(),
    updatedAt: 0,
  };
}

const LOW = '410000000000000001';
const MID = '410000000000000002';
const LEVEL = '410000000000000003';
const ABOVE = '410000000000000009';
const QUARANTINE = '410000000000000004';

const GUILD_STATE = state({
  [GUILD]: 0,
  [LOW]: 1,
  [QUARANTINE]: 2,
  [MID]: 3,
  [BOT_ROLE]: 6,
  [LEVEL]: 6,
  [ABOVE]: 9,
});

function record(priorRoleIds: string[]): QuarantineRecord {
  return {
    guildId: GUILD,
    userId: '400000000000000001',
    priorRoleIds,
    quarantinedBy: '100000000000000001',
    reason: null,
    quarantinedAt: 1_700_000_000_000,
  };
}

describe('checkGrantable — I8 hierarchy for the role, not the member', () => {
  test('allows a role below the bot', () => {
    expect(checkGrantable(GUILD_STATE, MID, 'member')).toEqual({ ok: true });
  });

  test('refuses a role above the bot, naming both positions and the fix', () => {
    const check = checkGrantable(GUILD_STATE, ABOVE, 'member');

    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('unreachable');
    expect(check.reason).toContain('position 9');
    expect(check.reason).toContain('position 6');
    expect(check.reason).toContain('Server Settings → Roles');

    expect(check.reason).toContain(ABOVE);
  });

  test('refuses a role at the bot’s own position — Discord requires strictly lower', () => {
    const check = checkGrantable(GUILD_STATE, LEVEL, 'member');
    expect(check.ok).toBe(false);
  });

  test('refuses @everyone, which Discord will not let anyone add or remove', () => {
    const check = checkGrantable(GUILD_STATE, GUILD, 'unverified');

    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('unreachable');
    expect(check.reason).toContain('@everyone');
  });

  test('refuses a role that no longer exists', () => {
    const check = checkGrantable(GUILD_STATE, '410000000000000099', 'quarantine');

    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('unreachable');
    expect(check.reason).toContain("doesn't exist");
  });

  test('refuses when there is no snapshot at all, rather than assuming it is fine', () => {
    expect(checkGrantable(null, MID, 'member').ok).toBe(false);
  });
});

describe('planQuarantine', () => {
  test('records every role but @everyone, highest position first', () => {
    const plan = planQuarantine({
      state: GUILD_STATE,
      memberRoleIds: [GUILD, LOW, MID],
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.priorRoleIds).toEqual([MID, LOW]);
  });

  test('strips before it marks, so the isolation actually takes effect', () => {
    const plan = planQuarantine({
      state: GUILD_STATE,
      memberRoleIds: [GUILD, LOW, MID],
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.steps).toEqual([
      { kind: 'remove_role', roleId: MID, what: `removing role ${MID}` },
      { kind: 'remove_role', roleId: LOW, what: `removing role ${LOW}` },
      { kind: 'add_role', roleId: QUARANTINE, what: 'applying the quarantine role' },
    ]);
  });

  test('never records the quarantine role as one of the prior roles', () => {
    const plan = planQuarantine({
      state: GUILD_STATE,
      memberRoleIds: [GUILD, QUARANTINE, LOW],
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.priorRoleIds).toEqual([LOW]);
  });

  test('a member with no roles yields an empty record and one step', () => {
    const plan = planQuarantine({
      state: GUILD_STATE,
      memberRoleIds: [GUILD],
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.priorRoleIds).toEqual([]);
    expect(plan.steps).toEqual([
      { kind: 'add_role', roleId: QUARANTINE, what: 'applying the quarantine role' },
    ]);
  });

  test('deduplicates a role Discord sent twice', () => {
    const plan = planQuarantine({
      state: GUILD_STATE,
      memberRoleIds: [LOW, LOW, MID],
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.priorRoleIds).toEqual([MID, LOW]);
  });
});

describe('planRelease', () => {
  test('restores the roles first and drops the quarantine role last', () => {
    const plan = planRelease({
      state: GUILD_STATE,
      record: record([MID, LOW]),
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.steps).toEqual([
      { kind: 'add_role', roleId: MID, what: `restoring role ${MID}` },
      { kind: 'add_role', roleId: LOW, what: `restoring role ${LOW}` },
      { kind: 'remove_role', roleId: QUARANTINE, what: 'removing the quarantine role' },
    ]);
  });

  test('an empty record still lifts the quarantine role', () => {
    const plan = planRelease({
      state: GUILD_STATE,
      record: record([]),
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.steps).toEqual([
      { kind: 'remove_role', roleId: QUARANTINE, what: 'removing the quarantine role' },
    ]);
    expect(plan.vanishedRoleIds).toEqual([]);
    expect(plan.ungrantableRoleIds).toEqual([]);
  });

  test('reports a role deleted while the member was quarantined instead of attempting it', () => {
    const plan = planRelease({
      state: GUILD_STATE,
      record: record([MID, '410000000000000099']),
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.vanishedRoleIds).toEqual(['410000000000000099']);
    expect(plan.steps.filter((step) => step.kind === 'add_role')).toEqual([
      { kind: 'add_role', roleId: MID, what: `restoring role ${MID}` },
    ]);
  });

  test('reports a role that has moved above Proton since the quarantine', () => {
    const plan = planRelease({
      state: GUILD_STATE,
      record: record([MID, ABOVE]),
      quarantineRoleId: QUARANTINE,
    });

    expect(plan.ungrantableRoleIds).toEqual([ABOVE]);
    expect(plan.vanishedRoleIds).toEqual([]);
  });
});
