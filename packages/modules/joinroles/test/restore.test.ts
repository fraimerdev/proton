import { describe, expect, test } from 'bun:test';
import type { GuildRole, GuildState } from '@proton/core';
import { planRestore } from '../src/restore.ts';

const GUILD = '900000000000000001';

function role(id: string, position: number, managed = false): GuildRole {
  return { id, permissions: 0n, position, ...(managed ? { managed: true } : {}) };
}

function state(overrides: Partial<GuildState> = {}): GuildState {
  const roles = new Map<string, GuildRole>([
    [GUILD, role(GUILD, 0)],
    ['700000000000000001', role('700000000000000001', 10)],
    ['700000000000000002', role('700000000000000002', 20)],
    ['700000000000000003', role('700000000000000003', 50)],
    ['700000000000000004', role('700000000000000004', 90)],
    ['700000000000000005', role('700000000000000005', 5, true)],
    ['800000000000000001', role('800000000000000001', 50)],
  ]);

  return {
    guildId: GUILD,
    ownerId: '100000000000000009',
    everyoneRoleId: GUILD,
    roles,
    botRoleIds: ['800000000000000001'],
    channels: new Map(),
    updatedAt: 0,
    ...overrides,
  };
}

describe('planRestore', () => {
  test('restores roles below the bot, lowest position first', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000002', '700000000000000001'],
      allowlist: [],
    });

    expect(plan.restore).toEqual(['700000000000000001', '700000000000000002']);
    expect(plan.skipped).toEqual([]);
  });

  test('refuses a role level with the bot, not just one above it', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000003'],
      allowlist: [],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('position 50');
  });

  test('refuses a role above the bot and says how to fix it', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000004'],
      allowlist: [],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('Server Settings');
  });

  test('refuses a managed role rather than spending a request to be told no', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000005'],
      allowlist: [],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('managed');
  });

  test('never restores @everyone', () => {
    const plan = planRestore({ state: state(), recordedRoleIds: [GUILD], allowlist: [] });

    expect(plan.restore).toEqual([]);
  });

  test('reports a role that has since been deleted', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000099'],
      allowlist: [],
    });

    expect(plan.skipped[0]?.reason).toContain('no longer exists');
  });

  test('an allowlist excludes everything not on it', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000001', '700000000000000002'],
      allowlist: ['700000000000000001'],
    });

    expect(plan.restore).toEqual(['700000000000000001']);
    expect(plan.skipped[0]?.roleId).toBe('700000000000000002');
    expect(plan.skipped[0]?.reason).toContain('eligible for restoring');
  });

  test('an empty allowlist means every role is eligible', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000001', '700000000000000002'],
      allowlist: [],
    });

    expect(plan.restore).toHaveLength(2);
  });

  test('duplicated recorded roles are restored once', () => {
    const plan = planRestore({
      state: state(),
      recordedRoleIds: ['700000000000000001', '700000000000000001'],
      allowlist: [],
    });

    expect(plan.restore).toEqual(['700000000000000001']);
  });

  test('with no guild state, restores nothing and explains', () => {
    const plan = planRestore({
      state: null,
      recordedRoleIds: ['700000000000000001'],
      allowlist: [],
    });

    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toContain("don't have this server's role list");
  });
});
