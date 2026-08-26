import { describe, expect, test } from 'bun:test';
import { type PrecheckInput, runPrechecks } from '../../src/actions/prechecks.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const OWNER = '200000000000000000';
const BOT = '300000000000000000';
const TARGET = '400000000000000000';
const CHANNEL = '500000000000000000';
const THREAD = '500000000000000009';
const GUILD = '900000000000000001';

function input(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    guildId: GUILD,
    guildOwnerId: OWNER,
    botUserId: BOT,
    botHighestRolePosition: 10,
    botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    requiredPermissions: Permissions.SendMessages,
    channelId: CHANNEL,
    ...overrides,
  };
}

function guildScoped(overrides: Partial<PrecheckInput> = {}): PrecheckInput {
  return {
    guildId: GUILD,
    guildOwnerId: OWNER,
    botUserId: BOT,
    botHighestRolePosition: 10,
    botChannelPermissions: Permissions.ViewChannel,
    requiredPermissions: Permissions.BanMembers,
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

    expect(failure?.humanReason).toContain('Send Messages');
    expect(failure?.humanReason).toContain(CHANNEL);
  });

  test('does not claim a channel check when that channel’s overwrites were never loaded', () => {
    const failure = runPrechecks(
      input({
        botChannelPermissions: Permissions.ViewChannel,
        requiredPermissions: Permissions.SendMessages,
        channelOverwritesUnknown: true,
      }),
    );

    expect(failure?.humanReason).toContain('Send Messages');
    expect(failure?.humanReason).toContain(CHANNEL);
    expect(failure?.humanReason).toContain('this server');
    expect(failure?.humanReason).not.toMatch(/permission in <#/);
  });

  test('sends the admin to the guild, not a channel, when no channel was resolved', () => {
    const failure = runPrechecks(guildScoped());

    expect(failure?.humanReason).toContain('Ban Members');
    expect(failure?.humanReason).toContain('this server');
    expect(failure?.humanReason).not.toContain('<#');
  });

  test('sends the admin to the parent channel when the permission is missing in a thread', () => {
    const failure = runPrechecks(
      input({
        channelId: THREAD,
        threadParentId: CHANNEL,
        botChannelPermissions: Permissions.ViewChannel,
        requiredPermissions: Permissions.SendMessagesInThreads,
      }),
    );

    expect(failure?.humanReason).toContain('Send Messages in Threads');
    expect(failure?.humanReason).toContain(`<#${THREAD}>`);
    expect(failure?.humanReason).toContain(`<#${CHANNEL}>`);
  });

  test('reports every missing permission, not just the first', () => {
    const failure = runPrechecks(
      input({
        botChannelPermissions: 0n,
        requiredPermissions: Permissions.ViewChannel | Permissions.SendMessages,
      }),
    );

    expect(failure?.humanReason).toContain('View Channel');
    expect(failure?.humanReason).toContain('Send Messages');
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

/**
 * A voice move is not a moderation action. Discord's Modify Guild Member documents `channel_id` as
 * requiring MOVE_MEMBERS and nothing else — no ranking, no owner exemption — so ranking it like a
 * ban meant the server owner could never be moved into the temporary channel just built for them.
 */
describe('a kind Discord does not rank', () => {
  test('the owner is movable', () => {
    expect(
      runPrechecks(input({ hierarchy: false, target: { id: OWNER, highestRolePosition: 0 } })),
    ).toBeNull();
  });

  test('a member ranked above the bot is movable', () => {
    expect(
      runPrechecks(input({ hierarchy: false, target: { id: TARGET, highestRolePosition: 99 } })),
    ).toBeNull();
  });

  test('a member merely tying the bot is movable, which `>=` used to refuse', () => {
    expect(
      runPrechecks(input({ hierarchy: false, target: { id: TARGET, highestRolePosition: 10 } })),
    ).toBeNull();
  });

  test('the bot still refuses to act on itself', () => {
    expect(
      runPrechecks(input({ hierarchy: false, target: { id: BOT, highestRolePosition: 0 } }))?.code,
    ).toBe('target_is_self');
  });

  test('a missing permission is still a missing permission', () => {
    expect(
      runPrechecks(
        input({
          hierarchy: false,
          requiredPermissions: Permissions.MoveMembers,
          botChannelPermissions: Permissions.ViewChannel,
          target: { id: OWNER, highestRolePosition: 0 },
        }),
      )?.code,
    ).toBe('missing_permission');
  });

  test('a ranked kind is unchanged: the owner is still refused', () => {
    expect(runPrechecks(input({ target: { id: OWNER, highestRolePosition: 0 } }))?.code).toBe(
      'target_is_owner',
    );
  });
});
