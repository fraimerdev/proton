import { describe, expect, test } from 'bun:test';
import { createJoinRolesListener } from '../src/listeners.ts';
import {
  collectingLogger,
  config,
  event,
  FakePendingStore,
  GUILD,
  guildState,
  RecordingExecutor,
  ROLE_LOW,
  SCREENEE,
  silent,
} from './harness.ts';

describe('membership screening', () => {
  test('a member who has not accepted the rules is deferred, not granted', async () => {
    const executor = new RecordingExecutor();
    const pending = new FakePendingStore();
    const listener = createJoinRolesListener({ guildState, pending });

    await listener.handler(event('guildMemberAddPending'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.requests).toEqual([]);
    expect(pending.marked).toEqual([SCREENEE]);
  });

  test('accepting the rules grants the held roles', async () => {
    const executor = new RecordingExecutor();
    const pending = new FakePendingStore();
    const listener = createJoinRolesListener({ guildState, pending });
    const ctx = {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    };

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(event('guildMemberUpdateScreened'), ctx);

    expect(executor.roleIds()).toEqual([ROLE_LOW]);
    expect(executor.requests[0]?.targetId).toBe(SCREENEE);
  });

  test('a member.updated with no deferred grant is left alone', async () => {
    const executor = new RecordingExecutor();
    const pending = new FakePendingStore();
    const listener = createJoinRolesListener({ guildState, pending });

    await listener.handler(event('guildMemberUpdateScreened'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(executor.requests).toEqual([]);
  });

  test('the deferred grant fires once, so a role removed by hand stays removed', async () => {
    const executor = new RecordingExecutor();
    const pending = new FakePendingStore();
    const listener = createJoinRolesListener({ guildState, pending });
    const ctx = {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    };

    await listener.handler(event('guildMemberAddPending'), ctx);
    await listener.handler(event('guildMemberUpdateScreened'), ctx);
    await listener.handler(event('guildMemberUpdateScreened'), ctx);

    expect(executor.requests).toHaveLength(1);
  });

  test('turning the wait off grants immediately, screening or not', async () => {
    const executor = new RecordingExecutor();
    const pending = new FakePendingStore();
    const listener = createJoinRolesListener({ guildState, pending });

    await listener.handler(event('guildMemberAddPending'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW], grantWhenScreeningPasses: false }),
      executor,
      logger: silent,
    });

    expect(executor.roleIds()).toEqual([ROLE_LOW]);
    expect(pending.marked).toEqual([]);
  });

  test('an unwired pending store grants immediately and names the missing wiring', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const listener = createJoinRolesListener({ guildState });

    await listener.handler(event('guildMemberAddPending'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger,
    });

    expect(executor.roleIds()).toEqual([ROLE_LOW]);
    expect(lines.join(' ')).toContain('no pending-grant store is wired');
  });
});
