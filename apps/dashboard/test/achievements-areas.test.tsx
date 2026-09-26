import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleConfigView } from '@proton/core';
import {
  type Achievement,
  type AchievementsConfig,
  achievementsConfigSchema,
} from '@proton/module-achievements/config';
import { achievementRevision } from '@proton/module-achievements/evaluate';
import type {
  AchievementsOverview,
  MemberDetail,
  RewardView,
  UnlockView,
} from '@proton/module-achievements/view';
import { levelingConfigSchema } from '@proton/module-leveling/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';

const SRC = join(import.meta.dir, '..', 'src');

const GUILD = '900000000000000002';
const MEMBER = '200000000000000001';
const ROLE = '300000000000000001';
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ZONE = 'Europe/London';

for (const file of readdirSync(join(SRC, 'server'))) {
  const source = readFileSync(join(SRC, 'server', file), 'utf8');
  const names = [...source.matchAll(/^export (?:const|(?:async )?function) (\w+)/gm)].map(
    ([, name]) => name as string,
  );

  mock.module(`../src/server/${file}`, () =>
    Object.fromEntries(names.map((name) => [name, async () => null])),
  );
}

const QUERIES = readFileSync(join(SRC, 'lib', 'queries.ts'), 'utf8');

mock.module('../src/lib/queries.ts', () => ({
  ...Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({ queryKey: ['stub', name, ...args], enabled: false }),
    ]),
  ),
  MEMBER_LOOKUP_MAX: 100,
  modulesQuery: (guildId: string) => ({
    queryKey: ['achievements-areas', 'modules', guildId],
    queryFn: async () => ({ modules: [] }),
  }),
  rolesQuery: (guildId: string) => ({
    queryKey: ['achievements-areas', 'roles', guildId],
    queryFn: async () => [],
  }),
  channelsQuery: (guildId: string) => ({
    queryKey: ['achievements-areas', 'channels', guildId],
    queryFn: async () => [],
  }),
  memberSearchQuery: (guildId: string, query: string) => ({
    queryKey: ['achievements-areas', 'member-search', guildId, query],
    queryFn: async () => [],
  }),
  membersQuery: (guildId: string, userIds: readonly string[]) => ({
    queryKey: ['achievements-areas', 'members', guildId, [...new Set(userIds)].sort()],
    queryFn: async () => [],
    enabled: userIds.length > 0,
  }),
}));

const route = await import('../src/components/module/route.tsx');
let search: Record<string, unknown> = {};

mock.module('../src/components/module/route.tsx', () => ({
  ...route,
  ModuleLink: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useModuleSearch: () => search,
  useModuleNavigate: () => () => undefined,
}));

const { AnnouncementsArea, withUnlockDestination } = await import(
  '../src/pages/achievements/announcements.tsx'
);
const { SettingsArea, pausesOf, pauseText } = await import(
  '../src/pages/achievements/settings.tsx'
);
const {
  MembersArea,
  announcementText,
  memberAchievements,
  retrySummary,
  rewardReason,
  versionSentence,
} = await import('../src/pages/achievements/members.tsx');
const { RankCardArea } = await import('../src/pages/leveling/card.tsx');
const { failedRewardsFilter, recentUnlocksFilter } = await import(
  '../src/pages/achievements/queries.ts'
);
const { formatZoned } = await import('../src/pages/achievements/time.ts');
const { MODULE_BY_ID } = await import('../src/lib/modules/catalogue.ts');
const { queryKeys } = await import('../src/lib/query-keys.ts');

const META = MODULE_BY_ID.get('achievements');
if (META === undefined) throw new Error('the catalogue has no achievements entry');

afterEach(() => {
  setSystemTime();
  search = {};
});

const CHATTERBOX: Achievement = {
  id: 'chatterbox',
  name: 'Chatterbox',
  description: 'Keep the conversation going.',
  status: 'active',
  badge: { shape: 'circle', icon: 'chat', colour: 'tier' },
  kind: 'tiered',
  requirements: [
    { id: 'msg', version: 1, trigger: 'messages.sent', channelIds: [], excludedChannelIds: [] },
  ],
  tiers: [
    { id: 'bronze', targets: { msg: 50 }, rewards: [] },
    { id: 'silver', targets: { msg: 250 }, rewards: [] },
    {
      id: 'gold',
      targets: { msg: 1000 },
      rewards: [
        { kind: 'add_role', roleId: ROLE },
        { kind: 'xp', amount: 250 },
      ],
    },
    { id: 'diamond', targets: { msg: 5000 }, rewards: [] },
  ],
  roleIds: [],
  excludedRoleIds: [],
  includeRecorded: false,
  almostThere: { enabled: false, percent: 80 },
  announcement: { mode: 'default' },
};

function formOf<T>(config: T, moduleId: string) {
  const view = {
    moduleId,
    enabled: true,
    config,
    schemaVersion: 1,
    migrated: false,
    tier: 'pro',
    postables: [],
    simulations: [],
  } as unknown as ModuleConfigView;

  const noop = (): void => undefined;

  return {
    view,
    value: config,
    setValue: noop,
    rebase: noop,
    get: () => undefined,
    set: noop,
    dirty: false,
    errors: new Map<string, string>(),
    errorAt: () => undefined,
    templateDiagnosticsAt: () => [],
    save: noop,
    reset: noop,
    saving: false,
    saveError: null,
    failures: 0,
    changedElsewhere: false,
  };
}

function configOf(input: Record<string, unknown> = {}): AchievementsConfig {
  return achievementsConfigSchema.parse({
    enabled: true,
    timezone: ZONE,
    achievements: [CHATTERBOX],
    ...input,
  });
}

const ROLES = new Map([
  [
    ROLE,
    {
      id: ROLE,
      name: 'Regular',
      position: 3,
      color: 0,
      managed: false,
      premiumSubscriber: false,
      assignable: true,
    },
  ],
]);

const FRAIMER = {
  id: MEMBER,
  displayName: 'Fraimer',
  username: 'fraimer',
  avatarUrl: null,
  bot: false,
};

function renderWith(node: ReactElement, seed: (client: QueryClient) => void = () => {}): string {
  setSystemTime(new Date(NOW));

  const client = new QueryClient();
  client.setQueryData(['achievements-areas', 'modules', GUILD], {
    modules: [{ id: 'achievements', enabled: true }],
  });
  client.setQueryData(['achievements-areas', 'roles', GUILD], [...ROLES.values()]);
  client.setQueryData(['achievements-areas', 'members', GUILD, [MEMBER]], [FRAIMER]);
  seed(client);

  return renderToString(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  ).replaceAll('<!-- -->', '');
}

function unlock(overrides: Partial<UnlockView> = {}): UnlockView {
  return {
    userId: MEMBER,
    achievementId: 'chatterbox',
    tierId: 'gold',
    generation: 0,
    tierIndex: 2,
    unlockedAt: NOW - DAY,
    revision: achievementRevision(CHATTERBOX),
    definition: {
      name: 'Chatterbox',
      kind: 'tiered',
      requirements: [
        {
          id: 'msg',
          version: 1,
          trigger: 'messages.sent',
          target: 1000,
          channelIds: [],
          excludedChannelIds: [],
        },
      ],
      rewards: [
        { kind: 'add_role', roleId: ROLE },
        { kind: 'xp', amount: 250 },
      ],
      revision: achievementRevision(CHATTERBOX),
    },
    progress: { msg: 1000 },
    cause: { metric: 'messages', occurredAt: NOW - DAY, sourceModule: 'discord', depth: 0 },
    originChannelId: null,
    announceGroup: 'group-1',
    announceStatus: 'sent',
    announceAttempts: 1,
    announceError: null,
    announcedAt: NOW - DAY,
    announceMessageId: '400000000000000001',
    publishedAt: NOW - DAY,
    voidedAt: null,
    voidedBy: null,
    ...overrides,
  };
}

function reward(overrides: Partial<RewardView> = {}): RewardView {
  return {
    userId: MEMBER,
    achievementId: 'chatterbox',
    tierId: 'gold',
    generation: 0,
    rewardKey: 'xp',
    rewardEpoch: 0,
    kind: 'xp',
    roleId: null,
    amount: 250,
    status: 'failed',
    attempts: 1,
    nextAttemptAt: null,
    transient: false,
    errorCode: 'leveling_off',
    error: 'Leveling is off in this server, so the 250 XP reward wasn’t given.',
    requestedAt: null,
    deliveredAt: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...overrides,
  };
}

const GIVEN_ROLE = reward({
  rewardKey: `add_role:${ROLE}`,
  kind: 'add_role',
  roleId: ROLE,
  amount: null,
  status: 'delivered',
  errorCode: null,
  error: null,
  deliveredAt: NOW - DAY,
});

const DETAIL: MemberDetail = {
  userId: MEMBER,
  facts: null,
  achievements: [
    {
      achievementId: 'chatterbox',
      generation: 0,
      rewardEpoch: 0,
      countedFrom: null,
      resetAt: null,
      resetBy: null,
      values: { msg: 1240 },
      unlocked: ['bronze', 'silver', 'gold'],
      almostNotified: [],
      almostNotifiedAt: null,
    },
  ],
  unlocks: [unlock()],
  voided: [],
  rewards: [GIVEN_ROLE, reward()],
};

const OVERVIEW: AchievementsOverview = {
  recordingSince: NOW - 120 * DAY,
  periods: {
    module: [
      { start: NOW - 120 * DAY, end: NOW - 100 * DAY },
      { start: NOW - 90 * DAY, end: null },
    ],
  },
  achievements: [],
};

describe('the announcements area', () => {
  function render(config: AchievementsConfig): string {
    return renderWith(
      <AnnouncementsArea
        guildId={GUILD}
        form={formOf(config, 'achievements')}
        meta={META as NonNullable<typeof META>}
        summary={undefined}
      />,
    );
  }

  test('the default posts in the current channel and offers a fallback', () => {
    const html = render(configOf());

    expect(html).toContain('When a member earns an achievement');
    expect(html).toContain('When there’s no current channel');
    expect(html).toContain(
      'Achievements earned outside a channel, such as from voice time, aren’t announced.',
    );
    expect(html).toContain('Attach the badge');
    expect(html).toContain('aria-label="More about Attach the badge"');
    expect(html).toContain('aria-label="More about When a member earns an achievement"');
    expect(html).toContain('Almost there');
    expect(html).toContain('Reminder cooldown');
    expect(html).toContain('Chatterbox');
    expect(html.match(/Link buttons/g)?.length).toBe(2);
  });

  test('a channel destination asks for the channel and drops the fallback', () => {
    const html = render(configOf({ announcement: { destination: 'channel' } }));

    expect(html).toContain('Announcement channel');
    expect(html).not.toContain('When there’s no current channel');
  });

  test('off drops the unlock message but keeps the badge switch, which custom announcements use', () => {
    const html = render(configOf({ announcement: { destination: 'none' } }));

    expect(html).toContain('Nothing is posted unless an achievement has its own announcement.');
    expect(html).toContain('Attach the badge');
    expect(html.match(/Link buttons/g)?.length).toBe(1);
  });

  test('a direct message has no mention switches, because DMs never ping', () => {
    const html = render(
      configOf({ announcement: { destination: 'dm' }, almostThere: { destination: 'dm' } }),
    );

    expect(html).toContain('DMs never ping anyone');
    expect(html).not.toContain('Ping @everyone and @here');
    expect(html).toContain('Sent to the member by DM.');
  });

  test('leaving the current channel drops a fallback channel that was never picked', () => {
    const stranded = configOf({ announcement: { fallback: 'channel' } });
    expect(withUnlockDestination(stranded, 'dm').announcement.fallback).toBe('none');
    expect(withUnlockDestination(stranded, 'current').announcement.fallback).toBe('channel');

    const picked = configOf({
      announcement: { fallback: 'channel', fallbackChannelId: '500000000000000001' },
    });
    expect(withUnlockDestination(picked, 'dm').announcement.fallback).toBe('channel');
  });
});

describe('the settings area', () => {
  function render(): string {
    return renderWith(
      <SettingsArea
        guildId={GUILD}
        form={formOf(configOf(), 'achievements')}
        meta={META as NonNullable<typeof META>}
        summary={undefined}
      />,
      (client) => client.setQueryData(queryKeys.achievementsOverview(GUILD), OVERVIEW),
    );
  }

  test('says what the time zone and exclusions do, with the details in help', () => {
    const html = render();

    expect(html).toContain('Sets which calendar day activity falls on');
    expect(html).toContain('aria-label="More about Time zone"');
    expect(html).toContain('aria-label="More about Excluded channels"');
    expect(html).toContain('Excluded roles');
    expect(html).toContain('0 / 50');
  });

  test('shows when recording started and each pause, with retention in help', () => {
    const html = render();

    expect(html).toContain(formatZoned(NOW - 120 * DAY, ZONE));
    expect(html).toContain(
      `${formatZoned(NOW - 100 * DAY, ZONE)} – ${formatZoned(NOW - 90 * DAY, ZONE)}`,
    );
    expect(html).toContain('aria-label="More about Recording"');
  });

  test('pauses are the gaps between periods, and an open end is a pause still running', () => {
    expect(pausesOf([{ start: 10, end: null }])).toEqual([]);
    expect(
      pausesOf([
        { start: 30, end: 40 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([
      { start: 20, end: 30 },
      { start: 40, end: null },
    ]);
    expect(pauseText({ start: NOW, end: null }, ZONE)).toBe(`Since ${formatZoned(NOW, ZONE)}`);
  });
});

describe('the members area', () => {
  function render(link: Record<string, unknown>, failed: readonly RewardView[]): string {
    search = { area: 'members', ...link };

    return renderWith(
      <MembersArea guildId={GUILD} form={formOf(configOf(), 'achievements')} />,
      (client) => {
        client.setQueryData(queryKeys.achievementRewards(GUILD, failedRewardsFilter(1)), {
          items: failed,
          total: failed.length,
          page: 1,
          pageSize: 25,
        });
        client.setQueryData(
          queryKeys.achievementUnlocks(GUILD, recentUnlocksFilter(search as never)),
          { items: [unlock()], total: 1, page: 1, pageSize: 25 },
        );
        client.setQueryData(queryKeys.achievementMember(GUILD, MEMBER), DETAIL);
      },
    );
  }

  test('failed rewards say why, with a retry for each and for all', () => {
    const html = render({}, [reward()]);

    expect(html).toContain('Failed rewards');
    expect(html).toContain('Leveling is off in this server, so the 250 XP reward wasn’t given.');
    expect(html).toContain('>Retry all<');
    expect(html).toContain('aria-label="Retry 250 XP for Fraimer, Chatterbox"');
  });

  test('no failed rewards is a short empty state', () => {
    const html = render({}, []);

    expect(html).toContain('No failed rewards');
    expect(html).not.toContain('>Retry all<');
  });

  test('a looked-up member shows progress, what they earned under which version, and each reward', () => {
    const html = render({ id: MEMBER }, []);

    expect(html).toContain('Towards Diamond');
    expect(html).toContain('1,240 / 5,000 messages (24%)');
    expect(html).toContain(
      'Earned on 18 Sep 2026 under the current version: send 1,000 messages; rewards attached: give @Regular and 250 XP.',
    );
    expect(html).toContain('Give @Regular');
    expect(html).toContain('>Given<');
    expect(html).toContain('>Failed<');
    expect(html).toContain('Reset this achievement…');
    expect(html).toContain('Reset all achievements…');
    expect(html).toContain('Recent unlocks');
  });

  test('a member id that isn’t a Discord id looks nobody up', () => {
    const html = render({ id: 'chatterbox' }, []);

    expect(html).not.toContain('Towards Diamond');
    expect(html).not.toContain('Reset all achievements…');
  });
});

describe('the members area’s sentences', () => {
  test('an unlock under an edited achievement says it was an earlier version', () => {
    const edited = { ...CHATTERBOX, tiers: CHATTERBOX.tiers.slice(0, 3) };
    const sentence = versionSentence(
      unlock(),
      achievementRevision(edited),
      ROLES,
      ZONE,
      () => undefined,
    );

    expect(sentence).toStartWith('Earned on 18 Sep 2026 under an earlier version:');
  });

  test('a retry outcome is counted by what happened, and only problems give reasons', () => {
    const ref = {
      userId: MEMBER,
      achievementId: 'chatterbox',
      tierId: 'gold' as const,
      generation: 0,
      rewardKey: 'xp',
    };

    const summary = retrySummary({
      results: [
        { ...ref, status: 'delivered', message: 'Given.' },
        {
          ...ref,
          rewardKey: `add_role:${ROLE}`,
          status: 'failed',
          message: 'Missing Manage Roles.',
        },
      ],
    });

    expect(summary.tone).toBe('warning');
    expect(summary.text).toBe('Retried 2 rewards: 1 given and 1 failed again.');
    expect(summary.reasons).toEqual(['Missing Manage Roles.']);

    expect(retrySummary({ results: [{ ...ref, status: 'requested', message: '' }] }).tone).toBe(
      'success',
    );
  });

  test('a transient failure says when Proton tries again; statuses read as sentences', () => {
    const next = NOW + DAY;
    expect(rewardReason(reward({ transient: true, nextAttemptAt: next }), ZONE)).toBe(
      `Leveling is off in this server, so the 250 XP reward wasn’t given. Proton tries again on ${formatZoned(next, ZONE)}.`,
    );
    expect(announcementText(unlock({ announceStatus: 'failed', announceError: null }), ZONE)).toBe(
      'The announcement failed: Proton didn’t record why.',
    );
  });

  test('rewards from before a reset are kept apart from the current tiers', () => {
    const items = memberAchievements(
      { ...DETAIL, rewards: [...DETAIL.rewards, reward({ generation: 1 })] },
      new Map([[CHATTERBOX.id, CHATTERBOX]]),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.rewards).toHaveLength(2);
    expect(items[0]?.earlier).toHaveLength(1);
  });
});

describe('the rank card', () => {
  test('has a switch for achievement badges, and says where they come from', () => {
    const config = levelingConfigSchema.parse({ rankCard: true });
    const html = renderWith(<RankCardArea guildId={GUILD} form={formOf(config, 'leveling')} />);

    expect(html).toContain('Show achievement badges');
    expect(html).toContain('Badges come from the Achievements module, when it’s on.');
  });
});
