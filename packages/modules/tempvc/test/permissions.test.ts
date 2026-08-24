import { describe, expect, test } from 'bun:test';
import { type PermissionOverwriteSpec, Permissions } from '@proton/core';
import {
  canJoin,
  MEMBER_OVERWRITE,
  planOverwrites,
  privacyOf,
  ROLE_OVERWRITE,
} from '../src/permissions.ts';

const GUILD = '900000000000000001';
const BOT = '300000000000000000';
const OWNER = '400000000000000001';
const FRIEND = '400000000000000002';
const PEST = '400000000000000003';

function plan(overrides: Partial<Parameters<typeof planOverwrites>[0]> = {}) {
  return planOverwrites({
    guildId: GUILD,
    botUserId: BOT,
    ownerId: OWNER,
    privacy: 'public',
    access: [],
    ...overrides,
  });
}

function entry(
  result: readonly PermissionOverwriteSpec[],
  id: string,
): PermissionOverwriteSpec | undefined {
  return result.find((candidate) => candidate.id === id);
}

const has = (value: string | undefined, bit: bigint): boolean =>
  (BigInt(value ?? '0') & bit) !== 0n;

describe('the bot keeps its own way in', () => {
  /**
   * Locking a channel denies @everyone Connect, and the bot is in @everyone. Without an explicit
   * member overwrite Proton loses Connect to the channel it is managing — it can no longer move
   * the owner back in, apply a later privacy change, or recover the channel at all.
   */
  test('every privacy mode still grants the bot Connect and Manage Channels', () => {
    for (const privacy of ['public', 'locked', 'private'] as const) {
      const bot = entry(plan({ privacy }), BOT);

      expect(`${privacy} connect: ${has(bot?.allow, Permissions.Connect)}`).toBe(
        `${privacy} connect: true`,
      );
      expect(`${privacy} manage: ${has(bot?.allow, Permissions.ManageChannels)}`).toBe(
        `${privacy} manage: true`,
      );
    }
  });

  test('a blocked bot id cannot deny itself', () => {
    const bot = entry(plan({ access: [{ userId: BOT, kind: 'block' }] }), BOT);

    expect(has(bot?.deny, Permissions.Connect)).toBe(false);
    expect(has(bot?.allow, Permissions.Connect)).toBe(true);
  });
});

describe('the owner is never locked out of their own channel', () => {
  test('locked and private both still let the owner in', () => {
    for (const privacy of ['locked', 'private'] as const) {
      const owner = entry(plan({ privacy }), OWNER);

      expect(`${privacy}: ${has(owner?.allow, Permissions.Connect)}`).toBe(`${privacy}: true`);
      expect(`${privacy} view: ${has(owner?.allow, Permissions.ViewChannel)}`).toBe(
        `${privacy} view: true`,
      );
    }
  });

  test('an ownerless channel simply has no owner overwrite', () => {
    expect(entry(plan({ ownerId: null }), OWNER)).toBeUndefined();
  });
});

describe('privacy is written as real overwrites', () => {
  test('public denies nothing on @everyone', () => {
    expect(entry(plan({ privacy: 'public' }), GUILD)).toBeUndefined();
  });

  test('locked denies Connect but leaves the channel visible', () => {
    const everyone = entry(plan({ privacy: 'locked' }), GUILD);

    expect(has(everyone?.deny, Permissions.Connect)).toBe(true);
    expect(has(everyone?.deny, Permissions.ViewChannel)).toBe(false);
  });

  test('private hides it as well', () => {
    const everyone = entry(plan({ privacy: 'private' }), GUILD);

    expect(has(everyone?.deny, Permissions.ViewChannel)).toBe(true);
  });

  test('what was written can be read back', () => {
    for (const privacy of ['public', 'locked', 'private'] as const) {
      expect(privacyOf(plan({ privacy }), GUILD)).toBe(privacy);
    }
  });
});

describe('trust and block', () => {
  test('a trusted member gets in even when the channel is private', () => {
    const result = plan({ privacy: 'private', access: [{ userId: FRIEND, kind: 'trust' }] });

    expect(canJoin(result, GUILD, FRIEND)).toBe(true);
    expect(canJoin(result, GUILD, PEST)).toBe(false);
  });

  test('a blocked member is kept out even when the channel is public', () => {
    const result = plan({ access: [{ userId: PEST, kind: 'block' }] });

    expect(canJoin(result, GUILD, PEST)).toBe(false);
    expect(canJoin(result, GUILD, FRIEND)).toBe(true);
  });

  test('one member is never both, whichever order the rows arrive in', () => {
    const result = plan({
      access: [
        { userId: PEST, kind: 'trust' },
        { userId: PEST, kind: 'block' },
      ],
    });

    const mine = entry(result, PEST);
    expect(has(mine?.allow, Permissions.Connect) && has(mine?.deny, Permissions.Connect)).toBe(
      false,
    );
  });
});

describe('inherited overwrites', () => {
  const inherited: PermissionOverwriteSpec[] = [
    {
      id: '500000000000000009',
      type: ROLE_OVERWRITE,
      allow: String(Permissions.Connect),
      deny: '0',
    },
  ];

  test('a synced role overwrite survives into the plan', () => {
    expect(entry(plan({ inherited }), '500000000000000009')).toBeDefined();
  });

  /**
   * The spec's ordering exists for this case: a category that trusts a staff role must not be able
   * to override the owner's own block, and Proton's own access is written last of all.
   */
  test('a block still beats an inherited allow for the same member', () => {
    const result = plan({
      inherited: [
        { id: PEST, type: MEMBER_OVERWRITE, allow: String(Permissions.Connect), deny: '0' },
      ],
      access: [{ userId: PEST, kind: 'block' }],
    });

    expect(canJoin(result, GUILD, PEST)).toBe(false);
  });

  test('nothing empty is sent to Discord', () => {
    const result = plan({
      inherited: [{ id: '500000000000000008', type: ROLE_OVERWRITE, allow: '0', deny: '0' }],
    });

    expect(result.every((e) => e.allow !== '0' || e.deny !== '0')).toBe(true);
  });
});
