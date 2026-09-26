import { describe, expect, test } from 'bun:test';
import type { RestProxyClient } from '@proton/core';
import type { AchievementInput, UnlockRow } from '@proton/module-achievements';
import {
  createAchievementBadges,
  createChannelKind,
  createMemberFacts,
  createMemberPages,
  effectivelyEnabled,
} from '../src/achievement-ports.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';

function restAnswering(status: number, body: unknown): { rest: RestProxyClient; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    rest: {
      async request(options) {
        paths.push(options.path);
        return { status, body };
      },
    },
  };
}

describe('member facts', () => {
  test('reads roles, the bot flag, and the join and boost times', async () => {
    const { rest, paths } = restAnswering(200, {
      user: { id: USER, bot: true },
      roles: ['200000000000000001'],
      joined_at: '2026-01-02T03:04:05.000Z',
      premium_since: null,
    });

    expect(await createMemberFacts(rest)(GUILD, USER)).toEqual({
      roleIds: ['200000000000000001'],
      bot: true,
      joinedAt: Date.parse('2026-01-02T03:04:05.000Z'),
      premiumSince: null,
    });
    expect(paths).toEqual([`/guilds/${GUILD}/members/${USER}`]);
  });

  test('someone Discord says is not a member is null', async () => {
    const { rest } = restAnswering(404, { code: 10007 });

    expect(await createMemberFacts(rest)(GUILD, USER)).toBeNull();
  });

  test('a bare 404 or a proxy failure throws rather than reading as gone', async () => {
    await expect(createMemberFacts(restAnswering(404, {}).rest)(GUILD, USER)).rejects.toThrow(
      'Discord answered 404',
    );
    await expect(createMemberFacts(restAnswering(502, {}).rest)(GUILD, USER)).rejects.toThrow(
      'the REST proxy answered 502',
    );
  });
});

describe('member pages', () => {
  test('pages after the cursor and hands them back in id order', async () => {
    const { rest, paths } = restAnswering(200, [
      { user: { id: '100000000000000010' }, joined_at: '2026-01-01T00:00:00.000Z' },
      { user: { id: '99000000000000000', bot: true }, joined_at: null },
    ]);

    expect(await createMemberPages(rest)(GUILD, null, 500)).toEqual([
      { userId: '99000000000000000', bot: true, joinedAt: null },
      {
        userId: '100000000000000010',
        bot: false,
        joinedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      },
    ]);
    expect(paths).toEqual([`/guilds/${GUILD}/members?limit=500&after=0`]);
  });

  test('a refusal for missing access names the Server Members intent', async () => {
    const { rest } = restAnswering(403, { code: 50001 });

    await expect(createMemberPages(rest)(GUILD, USER, 500)).rejects.toThrow('Server Members');
  });

  test('an unreadable entry fails the page instead of shortening it', async () => {
    const { rest } = restAnswering(200, [{ user: { id: USER } }, { joined_at: null }]);

    await expect(createMemberPages(rest)(GUILD, null, 500)).rejects.toThrow('cannot read');
  });
});

describe('channel kinds', () => {
  function kinds(ticket: object | null, temporary: { status: string } | null) {
    return createChannelKind({
      tickets: { byChannel: async () => ticket },
      temporary: { byChannel: async () => temporary },
    });
  }

  test('a ticket channel, a live temporary channel, and anything else', async () => {
    expect(await kinds({}, null)(GUILD, USER)).toBe('ticket');
    expect(await kinds(null, { status: 'live' })(GUILD, USER)).toBe('temporary');
    expect(await kinds(null, { status: 'reserving' })(GUILD, USER)).toBeNull();
    expect(await kinds(null, null)(GUILD, USER)).toBeNull();
  });
});

describe('effective enablement', () => {
  test('needs both the module switch and the config flag', () => {
    expect(effectivelyEnabled({ enabled: true, config: { enabled: true } })).toBe(true);
    expect(effectivelyEnabled({ enabled: true, config: {} })).toBe(true);
    expect(effectivelyEnabled({ enabled: true, config: { enabled: false } })).toBe(false);
    expect(effectivelyEnabled({ enabled: false, config: { enabled: true } })).toBe(false);
  });
});

describe('rank card badges', () => {
  const CHATTY: AchievementInput = {
    id: 'chatty',
    name: 'Chatty',
    kind: 'tiered',
    status: 'active',
    badge: { shape: 'shield', icon: 'chat', colour: 'tier' },
    requirements: [{ id: 'messages', trigger: 'messages.sent' }],
    tiers: [{ id: 'gold', targets: { messages: 10 } }],
  };

  const PICTURED: AchievementInput = {
    ...CHATTY,
    id: 'pictured',
    badge: {
      shape: 'hexagon',
      icon: 'star',
      colour: 0x123456,
      assetId: 'abcdefabcdefabcdefabcdefabcdefab',
    },
  };

  function rows(...unlocks: Array<[string, string]>): UnlockRow[] {
    return unlocks.map(
      ([achievementId, tierId]) => ({ achievementId, tierId }) as unknown as UnlockRow,
    );
  }

  function badges(snapshot: ModuleConfigSnapshot, unlocked: UnlockRow[], base64 = 'iVBORw0KGgo=') {
    const config: ConfigProvider = { get: async () => snapshot };
    return createAchievementBadges({
      config,
      store: {
        topBadges: async () => unlocked,
        earnedCount: async () => 7,
        badge: async () => ({ contentType: 'image/png', base64 }),
      },
    });
  }

  function sizedPng(width: number, height: number): string {
    const bytes = new Uint8Array(24);
    bytes.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ]);

    const header = new DataView(bytes.buffer);
    header.setUint32(16, width);
    header.setUint32(20, height);

    return Buffer.from(bytes).toString('base64');
  }

  test('none while the module or its config is off', async () => {
    const unlocked = rows(['chatty', 'gold']);
    const achievements = [CHATTY];

    expect(
      await badges({ enabled: false, config: { enabled: true, achievements } }, unlocked)(
        GUILD,
        USER,
      ),
    ).toEqual({ badges: [], count: 0 });
    expect(
      await badges({ enabled: true, config: { enabled: false, achievements } }, unlocked)(
        GUILD,
        USER,
      ),
    ).toEqual({ badges: [], count: 0 });
  });

  test('draws each configured badge, its uploaded image, and a retired one in its tier colour', async () => {
    const read = badges(
      { enabled: true, config: { enabled: true, achievements: [CHATTY, PICTURED] } },
      rows(['chatty', 'gold'], ['pictured', 'gold'], ['retired', 'bronze']),
    );

    expect(await read(GUILD, USER)).toEqual({
      badges: [
        { shape: 'shield', colour: '#d9a931', icon: 'chat' },
        { shape: 'hexagon', colour: '#123456', image: 'data:image/png;base64,iVBORw0KGgo=' },
        { shape: 'circle', colour: '#b0764a', icon: 'trophy' },
      ],
      count: 7,
    });
  });

  // One of these on a rank card used to take resvg's decoder, and the worker, down with it.
  test('a stored image declaring a bitmap no card can draw falls back to the icon', async () => {
    const read = badges(
      { enabled: true, config: { enabled: true, achievements: [PICTURED] } },
      rows(['pictured', 'gold']),
      sizedPng(16_000, 16_000),
    );

    expect(await read(GUILD, USER)).toEqual({
      badges: [{ shape: 'hexagon', colour: '#123456', icon: 'star' }],
      count: 7,
    });
  });
});
