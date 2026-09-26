import { describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleConfigView } from '@proton/core';
import {
  type Achievement,
  type AchievementsConfig,
  achievementSchema,
  achievementsConfigSchema,
} from '@proton/module-achievements/config';
import { triggerOf } from '@proton/module-achievements/triggers';
import { validateConfig } from '@proton/module-achievements/validate';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleForm } from '../src/components/module/form.ts';
import { queryKeys } from '../src/lib/query-keys.ts';

const SRC = join(import.meta.dir, '..', 'src');
const GUILD = '100000000000000001';
const REGULAR = '100000000000000011';
const GENERAL = '100000000000000021';
const LOUNGE = '100000000000000022';

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

mock.module('../src/lib/queries.ts', () =>
  Object.fromEntries(
    [...QUERIES.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => [
      name,
      (...args: unknown[]) => ({
        queryKey: ['stub', name, ...args],
        queryFn: async () => null,
        enabled: false,
      }),
    ]),
  ),
);

const route = await import('../src/components/module/route.tsx');

mock.module('../src/components/module/route.tsx', () => ({
  ...route,
  useModuleSearch: () => ({}),
  useModuleNavigate: () => () => undefined,
  ModuleLink: ({ children }: { children?: ReactNode }) => <a href="#module">{children}</a>,
}));

const {
  RequirementsTab,
  channelTypesFor,
  triggerOptions,
  withTrigger,
  addRequirement,
  removeRequirement,
  withXpSources,
} = await import('../src/pages/achievements/requirements.tsx');
const { addTier, convertKind, durationHint, ladderTargets, removeTopTier } = await import(
  '../src/pages/achievements/tiers.tsx'
);
const { ROLE_NOTE, rewardLabel, rewardProblem } = await import(
  '../src/pages/achievements/rewards.tsx'
);
const { TRY_IT_NOTE } = await import('../src/pages/achievements/try-it.tsx');
const { AnnouncementTab, announcesNowhere, defaultSummary, withDestination, withMode } =
  await import('../src/pages/achievements/announcement-override.tsx');

function single(overrides: Partial<Achievement> = {}): Achievement {
  return achievementSchema.parse({
    id: 'chatter',
    name: 'Chatter',
    kind: 'single',
    requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
    tiers: [{ id: 'single', targets: { msgs: 100 }, rewards: [] }],
    ...overrides,
  });
}

function tiered(overrides: Partial<Achievement> = {}): Achievement {
  return achievementSchema.parse({
    id: 'regular',
    name: 'Regular',
    kind: 'tiered',
    requirements: [{ id: 'days', trigger: 'activity.active_days' }],
    tiers: [
      { id: 'bronze', targets: { days: 7 }, rewards: [{ kind: 'xp', amount: 50 }] },
      { id: 'silver', targets: { days: 30 } },
      { id: 'gold', targets: { days: 90 } },
    ],
    ...overrides,
  });
}

function configOf(
  achievements: Achievement[],
  extra: Record<string, unknown> = {},
): AchievementsConfig {
  return achievementsConfigSchema.parse({ achievements, ...extra });
}

function formOf(
  config: AchievementsConfig,
  saved: AchievementsConfig = config,
): ModuleForm<AchievementsConfig> {
  const view = {
    moduleId: 'achievements',
    enabled: true,
    config: saved,
    schemaVersion: 1,
    migrated: false,
    tier: 'free',
    postables: [],
    simulations: [],
  } as unknown as ModuleConfigView;

  return {
    view,
    value: config,
    setValue: () => undefined,
    rebase: () => undefined,
    get: () => undefined,
    set: () => undefined,
    dirty: false,
    errors: new Map(),
    errorAt: () => undefined,
    templateDiagnosticsAt: () => [],
    save: () => undefined,
    reset: () => undefined,
    saving: false,
    saveError: null,
    failures: 0,
    changedElsewhere: false,
  };
}

function markup(node: ReactElement, seed?: (client: QueryClient) => void): string {
  const client = new QueryClient();
  seed?.(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function requirementsOf(
  config: AchievementsConfig,
  index = 0,
  seed?: (client: QueryClient) => void,
) {
  const achievement = config.achievements[index];
  if (achievement === undefined) throw new Error('no achievement at that index');

  return markup(
    <RequirementsTab
      guildId={GUILD}
      form={formOf(config)}
      index={index}
      achievement={achievement}
      saved={null}
      tryValues={{}}
      setTryValues={() => undefined}
    />,
    seed,
  );
}

function issuesFor(config: AchievementsConfig): string[] {
  return validateConfig(config, config).map((issue) => `${issue.path} ${issue.message}`);
}

describe('kind conversion', () => {
  test('single to tiered keeps the first requirement and makes ×1/×2/×5 tiers', () => {
    const from = single({
      requirements: [
        {
          id: 'msgs',
          version: 1,
          trigger: 'messages.sent',
          channelIds: [],
          excludedChannelIds: [],
        },
        {
          id: 'voice',
          version: 1,
          trigger: 'voice.minutes',
          channelIds: [],
          excludedChannelIds: [],
        },
      ],
      tiers: [
        {
          id: 'single',
          targets: { msgs: 120, voice: 60 },
          rewards: [{ kind: 'add_role', roleId: REGULAR }],
        },
      ],
    });

    const to = convertKind(from, 'tiered');

    expect(to.kind).toBe('tiered');
    expect(to.requirements.map((item) => item.id)).toEqual(['msgs']);
    expect(to.tiers.map((tier) => [tier.id, tier.targets.msgs])).toEqual([
      ['bronze', 120],
      ['silver', 240],
      ['gold', 600],
    ]);
    expect(to.tiers[0]?.rewards).toEqual([{ kind: 'add_role', roleId: REGULAR }]);
    expect(issuesFor(configOf([to]))).toEqual([]);
  });

  test('tiered to single keeps Bronze’s target and rewards', () => {
    const to = convertKind(tiered(), 'single');

    expect(to.tiers).toEqual([
      { id: 'single', targets: { days: 7 }, rewards: [{ kind: 'xp', amount: 50 }] },
    ]);
    expect(issuesFor(configOf([to]))).toEqual([]);
  });

  test('a requirement that can’t be tiered is replaced rather than kept', () => {
    const other = tiered();
    const from = single({
      requirements: [
        {
          id: 'pre',
          version: 1,
          trigger: 'achievements.unlocked',
          channelIds: [],
          excludedChannelIds: [],
          achievementId: other.id,
          tierId: 'bronze',
        },
      ],
      tiers: [{ id: 'single', targets: { pre: 1 }, rewards: [] }],
    });

    const to = convertKind(from, 'tiered');

    expect(to.requirements).toEqual([
      { id: 'pre', version: 1, trigger: 'messages.sent', channelIds: [], excludedChannelIds: [] },
    ]);
    expect(issuesFor(configOf([other, to]))).toEqual([]);
  });

  test('ladders stay strictly increasing at the top of a trigger’s range', () => {
    expect(ladderTargets('boosts.started', 3, 50)).toEqual([50, 99, 100]);
    expect(ladderTargets('voice.longest_stay', 4, 600)).toEqual([600, 1200, 1439, 1440]);
  });

  test('tiers are added at double the top target and removed from the top, never below two', () => {
    const four = addTier(tiered());
    expect(four.tiers.map((tier) => [tier.id, tier.targets.days])).toEqual([
      ['bronze', 7],
      ['silver', 30],
      ['gold', 90],
      ['diamond', 180],
    ]);
    expect(addTier(four)).toBe(four);

    const two = removeTopTier(removeTopTier(four));
    expect(two.tiers.map((tier) => tier.id)).toEqual(['bronze', 'silver']);
    expect(removeTopTier(two)).toBe(two);
  });

  test('membership days read as months or years', () => {
    expect(durationHint('membership.days', 180)).toBe('≈ 6 months');
    expect(durationHint('membership.days', 365)).toBe('≈ 1 year');
    expect(durationHint('membership.days', 730)).toBe('≈ 2 years');
    expect(durationHint('membership.days', 10)).toBeUndefined();
    expect(durationHint('messages.sent', 730)).toBeUndefined();
  });
});

describe('requirements', () => {
  test('tiered achievements only offer triggers that can be tiered', () => {
    const tieredValues = triggerOptions('tiered', 'messages.sent', true).map((o) => o.value);
    expect(tieredValues).not.toContain('achievements.unlocked');
    expect(tieredValues).toContain('leveling.level');

    expect(triggerOptions('single', 'messages.sent', true).map((o) => o.value)).toContain(
      'achievements.unlocked',
    );
    expect(triggerOptions('single', 'messages.sent', false).map((o) => o.value)).not.toContain(
      'achievements.unlocked',
    );
    expect(triggerOptions('single', 'messages.sent', true)[0]).toEqual({
      value: 'messages.sent',
      label: triggerOf('messages.sent').label,
      group: 'Messages',
    });
  });

  test('changing the trigger drops filters the new one can’t use and resets its targets', () => {
    const from = single({
      requirements: [
        {
          id: 'msgs',
          version: 2,
          trigger: 'messages.sent',
          channelIds: [GENERAL],
          excludedChannelIds: [LOUNGE],
        },
      ],
      tiers: [{ id: 'single', targets: { msgs: 5000 }, rewards: [] }],
    });

    const reactions = withTrigger(from, 'msgs', 'reactions.given');
    expect(reactions.requirements[0]).toEqual({
      id: 'msgs',
      version: 2,
      trigger: 'reactions.given',
      channelIds: [GENERAL],
      excludedChannelIds: [LOUNGE],
    });
    expect(reactions.tiers[0]?.targets).toEqual({ msgs: 50 });

    const voice = withTrigger(from, 'msgs', 'voice.minutes');
    expect(voice.requirements[0]?.channelIds).toEqual([]);
    expect(voice.requirements[0]?.excludedChannelIds).toEqual([]);

    const level = withTrigger(from, 'msgs', 'leveling.level');
    expect(level.requirements[0]).toEqual({
      id: 'msgs',
      version: 2,
      trigger: 'leveling.level',
      channelIds: [],
      excludedChannelIds: [],
    });
    expect(level.tiers[0]?.targets).toEqual({ msgs: 5 });
  });

  test('requirements are added up to three with a fresh trigger, and removed with their targets', () => {
    const two = addRequirement(single(), 'second');
    expect(two.requirements.map((item) => item.trigger)).toEqual([
      'messages.sent',
      'voice.minutes',
    ]);
    expect(two.tiers[0]?.targets).toEqual({ msgs: 100, second: 60 });

    const three = addRequirement(two, 'third');
    expect(three.requirements.map((item) => item.trigger)).toEqual([
      'messages.sent',
      'voice.minutes',
      'leveling.level',
    ]);
    expect(addRequirement(three, 'fourth')).toBe(three);
    expect(addRequirement(tiered(), 'more')).toEqual(tiered());

    const back = removeRequirement(three, 'second');
    expect(back.requirements.map((item) => item.id)).toEqual(['msgs', 'third']);
    expect(back.tiers[0]?.targets).toEqual({ msgs: 100, third: 5 });
    expect(issuesFor(configOf([back]))).toEqual([]);
  });

  test('XP sources are stored only when they differ from messages and voice', () => {
    const base = single().requirements[0];
    if (base === undefined) throw new Error('no requirement');
    const xp = { ...base, trigger: 'leveling.activity_xp' as const };

    expect('xpSources' in withXpSources(xp, ['voice', 'message'])).toBe(false);
    expect(withXpSources(xp, ['reward', 'message', 'voice']).xpSources).toEqual([
      'message',
      'voice',
      'reward',
    ]);
  });
});

describe('rewards', () => {
  test('labels read as the admin sees them', () => {
    expect(rewardLabel({ kind: 'add_role', roleId: REGULAR }, 'Regular')).toBe('Give @Regular');
    expect(rewardLabel({ kind: 'remove_role', roleId: REGULAR }, 'Regular')).toBe(
      'Remove @Regular',
    );
    expect(rewardLabel({ kind: 'xp', amount: 2500 })).toBe('2,500 XP');
  });

  test('a repeated or contradictory reward is refused before it is added', () => {
    const held = [
      { kind: 'add_role' as const, roleId: REGULAR },
      { kind: 'xp' as const, amount: 5 },
    ];

    expect(rewardProblem(held, { kind: 'add_role', roleId: REGULAR })).toBe(
      'That reward is already here.',
    );
    expect(rewardProblem(held, { kind: 'xp', amount: 10 })).toBe('That reward is already here.');
    expect(rewardProblem(held, { kind: 'remove_role', roleId: REGULAR })).toContain(
      'can’t give and remove the same role',
    );
    expect(rewardProblem(held, { kind: 'remove_role', roleId: GENERAL })).toBeNull();
  });
});

describe('Requirements tab', () => {
  test('a single achievement shows its filters and target, with the rule and role note in help', () => {
    const html = requirementsOf(configOf([single()]));
    const rule = triggerOf('messages.sent');

    expect(html).toContain('Members need all of these.');
    expect(html).toContain('aria-label="More about Send messages"');
    expect(html).not.toContain(rule.rule);
    expect(html).toContain('Only in these channels');
    expect(html).toContain('Not in these channels');
    expect(html).toContain('Add requirement');
    expect(html).toContain('Target');
    expect(html).toContain('aria-label="More about Rewards"');
    expect(html).not.toContain(ROLE_NOTE);
    expect(html).toContain(TRY_IT_NOTE);
    expect(html).not.toContain('XP sources');
    expect(html).not.toContain('class="tree-logic"');
  });

  test('a tiered achievement is a ladder with no combined requirements', () => {
    const html = requirementsOf(configOf([tiered()]));

    expect(html).not.toContain('Members need all of these.');
    expect(html).not.toContain('Add requirement');
    expect(html).not.toContain('Only in these channels');
    expect(html).toContain('Bronze');
    expect(html).toContain('Silver');
    expect(html).toContain('Gold');
    expect(html).toContain('Add Diamond');
    expect(html).toContain('Remove Gold');
    expect(html).toContain('aria-label="More about Be active on different days"');
    expect(html).toContain('aria-label="More about Tiers"');
    expect(html).toContain('50 XP');
  });

  test('combined requirements are joined by the logic connector and each can be removed', () => {
    const html = requirementsOf(configOf([addRequirement(single(), 'second')]));

    expect(html).toContain('class="tree-logic"');
    expect(html).toContain('Remove requirement 1');
    expect(html).toContain('Remove requirement 2');
  });

  test('a requirement whose module is off says it is paused', () => {
    const level = single({
      requirements: [
        {
          id: 'lvl',
          version: 1,
          trigger: 'leveling.level',
          channelIds: [],
          excludedChannelIds: [],
        },
      ],
      tiers: [{ id: 'single', targets: { lvl: 5 }, rewards: [] }],
    });

    const html = requirementsOf(configOf([level]), 0, (client) =>
      client.setQueryData(['stub', 'modulesQuery', GUILD], {
        modules: [{ id: 'leveling', enabled: false }],
      }),
    );

    expect(html).toContain('Leveling is off, so this requirement is paused until you turn it on.');
    expect(html).toContain(String(triggerOf('leveling.level').stateNote));
  });

  test('a new reward role Proton can’t manage is named beside the rewards', () => {
    const rewarded = single({
      tiers: [
        { id: 'single', targets: { msgs: 100 }, rewards: [{ kind: 'add_role', roleId: REGULAR }] },
      ],
    });

    const html = markup(
      <RequirementsTab
        guildId={GUILD}
        form={formOf(configOf([rewarded]), configOf([]))}
        index={0}
        achievement={rewarded}
        saved={null}
        tryValues={{}}
        setTryValues={() => undefined}
      />,
      (client) => {
        client.setQueryData(
          ['stub', 'rolesQuery', GUILD],
          [
            {
              id: REGULAR,
              name: 'Regular',
              position: 2,
              color: 0,
              managed: false,
              premiumSubscriber: false,
              assignable: true,
            },
          ],
        );
        client.setQueryData(queryKeys.protonRolePower(GUILD), {
          manageRoles: false,
          highestPosition: 9,
        });
      },
    );

    expect(html).toContain('Give @Regular');
    expect(html).toContain(
      'Proton doesn’t have Manage Roles in this server, so it can’t give @Regular.',
    );
  });

  test('channel filters reach the chats of voice and stage channels, and media posts', () => {
    const types = channelTypesFor('messages.sent');

    expect(types).toContain(2);
    expect(types).toContain(13);
    expect(types).toContain(16);
    expect(channelTypesFor('voice.minutes')).toEqual([2, 13, 4]);
  });

  test('a prerequisite that is no longer there, or no longer tiered, is named on its row', () => {
    const other = tiered();
    const dependent = single({
      id: 'all-rounder',
      name: 'All-Rounder',
      requirements: [
        {
          id: 'pre',
          version: 1,
          trigger: 'achievements.unlocked',
          channelIds: [],
          excludedChannelIds: [],
          achievementId: other.id,
          tierId: 'silver',
        },
      ],
      tiers: [{ id: 'single', targets: { pre: 1 }, rewards: [] }],
    });

    const gone = requirementsOf(configOf([dependent]));
    expect(gone).toContain('That achievement doesn’t exist any more. Pick another one.');

    const nowSingle = requirementsOf(configOf([dependent, convertKind(other, 'single')]));
    expect(nowSingle).toContain('is a single achievement, so it has no Silver tier.');
  });

  test('tiers out of order are named on the rung before saving', () => {
    const backwards = tiered({
      tiers: [
        { id: 'bronze', targets: { days: 30 }, rewards: [] },
        { id: 'silver', targets: { days: 7 }, rewards: [] },
      ],
    });

    expect(requirementsOf(configOf([backwards]))).toContain('Silver needs more than Bronze.');
  });

  test('Try it shows what the values would earn and the progress towards the next tier', () => {
    const achievement = tiered();
    const html = markup(
      <RequirementsTab
        guildId={GUILD}
        form={formOf(configOf([achievement]))}
        index={0}
        achievement={achievement}
        saved={null}
        tryValues={{ days: 12 }}
        setTryValues={() => undefined}
      />,
    );

    expect(html).toContain('If a member had…');
    expect(html).toContain('Towards Silver');
    expect(html).toContain('12 / 30 active days (40%)');
    expect(html).toContain('▰▰▰▰▱▱▱▱▱▱');
    expect(html.match(/Would be earned/g)?.length).toBe(1);
  });
});

describe('announcement override', () => {
  const voiceOnly = single({
    requirements: [
      { id: 'vc', version: 1, trigger: 'voice.minutes', channelIds: [], excludedChannelIds: [] },
    ],
    tiers: [{ id: 'single', targets: { vc: 60 }, rewards: [] }],
  });

  test('Custom starts from the server default, and leaving it removes the stored message', () => {
    const config = configOf([single()], {
      announcement: { destination: 'channel', channelId: GENERAL },
    });

    const custom = withMode(single(), 'custom', config.announcement);
    expect(custom.announcement).toEqual({
      mode: 'custom',
      destination: 'channel',
      channelId: GENERAL,
      message: config.announcement.message,
    });
    expect(custom.announcement.message).not.toBe(config.announcement.message);

    expect(withMode(custom, 'off', config.announcement).announcement).toEqual({ mode: 'off' });
    expect(withMode(custom, 'default', config.announcement).announcement).toEqual({
      mode: 'default',
    });

    const dm = withDestination(custom, 'dm', undefined);
    expect(dm.announcement.channelId).toBeUndefined();
    expect(withDestination(dm, 'channel', LOUNGE).announcement.channelId).toBe(LOUNGE);
    expect(issuesFor(configOf([custom], { announcement: config.announcement }))).toEqual([]);
  });

  test('an achievement with no channel to post in and no fallback is flagged', () => {
    expect(announcesNowhere(configOf([voiceOnly]), voiceOnly)).toBe(true);
    expect(announcesNowhere(configOf([single()]), single())).toBe(false);
    expect(
      announcesNowhere(configOf([voiceOnly], { announcement: { fallback: 'dm' } }), voiceOnly),
    ).toBe(false);

    const toChannel = withDestination(
      withMode(voiceOnly, 'custom', configOf([]).announcement),
      'channel',
      GENERAL,
    );
    expect(announcesNowhere(configOf([toChannel]), toChannel)).toBe(false);
  });

  test('the server default is summarised in one line', () => {
    const none = (): undefined => undefined;
    const base = configOf([]).announcement;

    expect(defaultSummary(base, none)).toBe(
      'The server default posts it in the channel where it was earned.',
    );
    expect(defaultSummary({ ...base, fallback: 'dm' }, none)).toBe(
      'The server default posts it in the channel where it was earned, or by DM when it was earned outside a channel.',
    );
    expect(
      defaultSummary({ ...base, destination: 'channel', channelId: GENERAL }, (id) =>
        id === GENERAL
          ? { id, name: 'general', type: 0, parentId: null, parentName: null }
          : undefined,
      ),
    ).toBe('The server default posts it in #general.');
    expect(defaultSummary({ ...base, destination: 'dm' }, none)).toBe(
      'The server default sends it to the member by DM.',
    );
  });

  test('Server default renders its summary, a link to Announcements and a preview', () => {
    const config = configOf([voiceOnly]);
    const html = markup(
      <AnnouncementTab
        guildId={GUILD}
        form={formOf(config)}
        index={0}
        achievement={voiceOnly}
        tryValues={{}}
      />,
    );

    expect(html).toContain('Server default');
    expect(html).toContain('The server default posts it in the channel where it was earned.');
    expect(html).toContain('Change it in Announcements');
    expect(html).toContain('None of these requirements happen in a channel');
    expect(html).toContain('Choose Custom, or set a fallback in Announcements.');
    expect(html).toContain('Chatter');
  });

  test('Custom renders the destination and the message editor for this achievement', () => {
    const custom = withMode(single(), 'custom', configOf([]).announcement);
    const html = markup(
      <AnnouncementTab
        guildId={GUILD}
        form={formOf(configOf([custom]))}
        index={0}
        achievement={custom}
        tryValues={{}}
      />,
    );

    expect(html).toContain('Current channel');
    expect(html).toContain('>DM<');
    expect(html).toContain('Link buttons');
    expect(html).toContain('Mentions');
    expect(html).toContain('earned <strong');
    expect(html).not.toContain('Change it in Announcements');
  });

  test('a custom direct message has no mention switches, because DMs never ping', () => {
    const dm = withDestination(
      withMode(single(), 'custom', configOf([]).announcement),
      'dm',
      undefined,
    );
    const html = markup(
      <AnnouncementTab
        guildId={GUILD}
        form={formOf(configOf([dm]))}
        index={0}
        achievement={dm}
        tryValues={{}}
      />,
    );

    expect(html).toContain('DMs never ping anyone');
    expect(html).not.toContain('Ping @everyone and @here');
    expect(html).not.toContain('Ping members');
  });

  test('Don’t announce shows nothing to post', () => {
    const off = withMode(single(), 'off', configOf([]).announcement);
    const html = markup(
      <AnnouncementTab
        guildId={GUILD}
        form={formOf(configOf([off]))}
        index={0}
        achievement={off}
        tryValues={{}}
      />,
    );

    expect(html).toContain('Proton posts nothing when a member earns it. Rewards are still given.');
    expect(html).toContain('Nothing is posted for this achievement.');
  });
});
