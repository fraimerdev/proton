import { describe, expect, test } from 'bun:test';
import { planGrant } from '../src/grant.ts';
import { createJoinRolesListener } from '../src/listeners.ts';
import {
  BOT_MEMBER,
  collectingLogger,
  config,
  event,
  FakeStore,
  GUILD,
  guildState,
  MEMBER,
  RecordingExecutor,
  ROLE_ABOVE_BOT,
  ROLE_GONE,
  ROLE_LOW,
  ROLE_MANAGED,
  ROLE_MID,
  STATE,
  silent,
} from './harness.ts';

describe('granting roles on join', () => {
  test('a configured member role produces an add_role on member.joined', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.kind).toBe('add_role');
    expect(executor.requests[0]?.targetId).toBe(MEMBER);
    expect(executor.requests[0]?.payload).toEqual({ userId: MEMBER, roleId: ROLE_LOW });
  });

  test('several configured roles are granted lowest-first', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_MID, ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.roleIds()).toEqual([ROLE_LOW, ROLE_MID]);
  });

  test('a joining bot receives the bot list, not the member list', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAddBot'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW], botRoleIds: [ROLE_MID] }),
      executor,
      logger: silent,
    });

    expect(executor.roleIds()).toEqual([ROLE_MID]);
    expect(executor.requests[0]?.targetId).toBe(BOT_MEMBER);
    expect(executor.requests[0]?.reason).toContain('bot');
  });

  test('a joining bot with an empty bot list gets nothing', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAddBot'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.requests).toEqual([]);
  });

  test('Proton itself is never granted its own join roles', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState, botUserId: MEMBER });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.requests).toEqual([]);
  });

  test('a redelivered join grants once', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState });
    const ctx = {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    };

    await listener.handler(event('guildMemberAdd'), ctx);
    await listener.handler(event('guildMemberAdd'), ctx);

    expect(executor.requests[0]?.idempotencyKey).toBe(executor.requests[1]?.idempotencyKey ?? '');
  });

  test('a later rejoin is a new grant, not a duplicate', async () => {
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ guildState });
    const ctx = {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    };

    await listener.handler(event('guildMemberAdd'), ctx);

    const rejoin = event('guildMemberAdd');
    (rejoin.payload as Record<string, unknown>).joined_at = '2026-09-01T09:00:00.000000+00:00';
    await listener.handler(rejoin, ctx);

    expect(executor.requests[0]?.idempotencyKey).not.toBe(executor.requests[1]?.idempotencyKey);
  });

  test('the grant switch off grants nothing and says which switch', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ enabled: false, memberRoleIds: [ROLE_LOW] }),
      executor,
      logger,
    });

    expect(executor.requests).toEqual([]);
    expect(lines.join(' ')).toContain('Grant roles on join');
  });

  test('sticky restore still runs while the grant switch is off', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, [ROLE_MID]);
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ store, guildState });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ enabled: false, stickyEnabled: true, memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.roleIds()).toEqual([ROLE_MID]);
  });

  test('a role granted on join is not restored again by sticky roles', async () => {
    const store = new FakeStore();
    store.seed(MEMBER, [ROLE_LOW, ROLE_MID]);
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ store, guildState });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW], stickyEnabled: true }),
      executor,
      logger: silent,
    });

    expect(executor.roleIds()).toEqual([ROLE_LOW, ROLE_MID]);
  });

  test('a bot rejoining is never sticky-restored', async () => {
    const store = new FakeStore();
    store.seed(BOT_MEMBER, [ROLE_MID]);
    const executor = new RecordingExecutor();
    const listener = createJoinRolesListener({ store, guildState });

    await listener.handler(event('guildMemberAddBot'), {
      guildId: GUILD,
      config: config({ stickyEnabled: true }),
      executor,
      logger: silent,
    });

    expect(executor.requests).toEqual([]);
  });

  test('a refused grant is logged with the executor’s own reason', async () => {
    const executor = new RecordingExecutor();
    executor.result = {
      status: 'failed_precheck',
      failure: { code: 'role_hierarchy', humanReason: 'that role sits above mine.' },
    };
    const { logger, lines } = collectingLogger();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger,
    });

    expect(lines.join(' ')).toContain('that role sits above mine.');
  });
});

describe('planGrant', () => {
  test('a role above the bot is skipped with a reason naming the positions', () => {
    const plan = planGrant({ state: STATE, wantedRoleIds: [ROLE_ABOVE_BOT], heldRoleIds: [] });

    expect(plan.grant).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('position 90');
    expect(plan.skipped[0]?.reason).toContain('Server Settings');
  });

  test('@everyone is skipped', () => {
    const plan = planGrant({ state: STATE, wantedRoleIds: [GUILD], heldRoleIds: [] });

    expect(plan.grant).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('@everyone');
  });

  test('a managed role is skipped', () => {
    const plan = planGrant({ state: STATE, wantedRoleIds: [ROLE_MANAGED], heldRoleIds: [] });

    expect(plan.grant).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('managed');
  });

  test('a deleted role is skipped and points at the dashboard', () => {
    const plan = planGrant({ state: STATE, wantedRoleIds: [ROLE_GONE], heldRoleIds: [] });

    expect(plan.grant).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('no longer exists');
  });

  test('a role the member already holds is skipped', () => {
    const plan = planGrant({ state: STATE, wantedRoleIds: [ROLE_LOW], heldRoleIds: [ROLE_LOW] });

    expect(plan.grant).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('already has it');
  });

  test('duplicates in the configured list are granted once', () => {
    const plan = planGrant({
      state: STATE,
      wantedRoleIds: [ROLE_LOW, ROLE_LOW],
      heldRoleIds: [],
    });

    expect(plan.grant).toEqual([ROLE_LOW]);
  });

  test('an unknown guild state still grants — unlike restoring, this is an explicit setting', () => {
    const plan = planGrant({
      state: null,
      wantedRoleIds: [ROLE_LOW, ROLE_ABOVE_BOT],
      heldRoleIds: [],
    });

    expect(plan.grant).toEqual([ROLE_LOW, ROLE_ABOVE_BOT]);
    expect(plan.skipped).toEqual([]);
  });
});
