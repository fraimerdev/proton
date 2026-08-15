import { describe, expect, test } from 'bun:test';
import { type PrecheckInput, runPrechecks } from '../../src/actions/prechecks.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const OWNER = '200000000000000000';
const BOT = '300000000000000000';
const TARGET = '400000000000000000';
const CHANNEL = '500000000000000000';

function input(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    guildId: '900000000000000001',
    guildOwnerId: OWNER,
    botUserId: BOT,
    botHighestRolePosition: 10,
    botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    requiredPermissions: Permissions.SendMessages,
    channelId: CHANNEL,
    ...overrides,
  };
}

describe('runPrechecks', () => {
  test('passes when everything is in order', () => {
    expect(runPrechecks(input())).toBeNull();
  });

  test('names the missing permission and the channel it is missing in', () => {
    const failure = runPrechecks(
      input({
        botChannelPermissions: Permissions.ViewChannel,
        requiredPermissions: Permissions.SendMessages,
      }),
    );

    expect(failure?.code).toBe('missing_permission');

    expect(failure?.humanReason).toContain('SendMessages');
    expect(failure?.humanReason).toContain(CHANNEL);
  });

  test('reports every missing permission, not just the first', () => {
    const failure = runPrechecks(
      input({
        botChannelPermissions: 0n,
        requiredPermissions: Permissions.ViewChannel | Permissions.SendMessages,
      }),
    );

    expect(failure?.humanReason).toContain('ViewChannel');
    expect(failure?.humanReason).toContain('SendMessages');
  });

  test('refuses to act on the bot itself', () => {
    const failure = runPrechecks(input({ target: { id: BOT, highestRolePosition: 1 } }));

    expect(failure?.code).toBe('target_is_self');
  });

  test('refuses to act on the guild owner', () => {
    const failure = runPrechecks(input({ target: { id: OWNER, highestRolePosition: 1 } }));

    expect(failure?.code).toBe('target_is_owner');
    expect(failure?.humanReason).toContain('owner');
  });

  test('refuses a target whose highest role is above the bot', () => {
    const failure = runPrechecks(input({ target: { id: TARGET, highestRolePosition: 11 } }));

    expect(failure?.code).toBe('role_hierarchy');

    expect(failure?.humanReason).toContain('Roles');
  });

  test('refuses a target at exactly the bot’s role position', () => {
    const failure = runPrechecks(input({ target: { id: TARGET, highestRolePosition: 10 } }));

    expect(failure?.code).toBe('role_hierarchy');
  });

  test('allows a target below the bot', () => {
    expect(runPrechecks(input({ target: { id: TARGET, highestRolePosition: 9 } }))).toBeNull();
  });

  test('checks permissions before hierarchy, so the more basic problem wins', () => {
    const failure = runPrechecks(
      input({
        botChannelPermissions: 0n,
        target: { id: OWNER, highestRolePosition: 99 },
      }),
    );

    expect(failure?.code).toBe('missing_permission');
  });
});
