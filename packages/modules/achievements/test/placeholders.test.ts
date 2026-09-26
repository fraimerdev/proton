import { describe, expect, test } from 'bun:test';
import {
  definitionsFor,
  SAMPLE_ACHIEVEMENT,
  SAMPLE_NOW,
  type TemplateReport,
  validateConfigTemplates,
  validateTemplate,
} from '@proton/core/placeholders';
import {
  type AchievementInput,
  type AchievementsConfig,
  type AchievementsConfigInput,
  type AnnouncementMessage,
  achievementsConfigSchema,
  achievementsDefaultConfig,
  announcementMessageSchema,
} from '../src/config.ts';
import {
  ACHIEVEMENT_ALMOST_THERE_DM_SURFACE,
  ACHIEVEMENT_ALMOST_THERE_SURFACE,
  ACHIEVEMENT_SURFACES,
  ACHIEVEMENT_UNLOCKED_DM_SURFACE,
  ACHIEVEMENT_UNLOCKED_SURFACE,
  type AchievementMessageKind,
  type AchievementPlaceholderFacts,
  achievementsTemplates,
  almostThereRoute,
  previewFacts,
  renderAchievementMessage,
  toSendBody,
  unlockRoute,
  usedAchievementKeys,
  withBadgeThumbnail,
} from '../src/placeholders.ts';

const GUILD = '100000000000000001';
const CHANNEL = '800000000000000001';
const OTHER_CHANNEL = '800000000000000002';
const ROLE_A = '800000000000000021';
const ROLE_B = '800000000000000022';
const USER = '900000000000000002';

const MESSAGES = { one: 'message', many: 'messages' };
const VOICE = { one: 'voice minute', many: 'voice minutes' };

function facts(overrides: Partial<AchievementPlaceholderFacts> = {}): AchievementPlaceholderFacts {
  return {
    userId: USER,
    user: { id: USER, username: 'member', globalName: 'Member', avatarHash: null },
    member: 'unavailable',
    server: { id: GUILD },
    bot: null,
    originChannel: { id: CHANNEL, name: 'general' },
    destinationChannel: { id: OTHER_CHANNEL, name: 'achievements' },
    achievement: {
      id: 'chatterbox',
      name: 'Chatterbox',
      description: '**Talk** a lot',
      kind: 'tiered',
      tierCount: 4,
    },
    tier: 'silver',
    tiersUnlocked: ['silver', 'bronze'],
    requirements: [
      {
        trigger: 'messages.sent',
        label: 'Send 100 messages',
        current: 120,
        target: 100,
        unit: MESSAGES,
      },
    ],
    rewards: {
      granted: [
        { kind: 'add_role', roleId: ROLE_A },
        { kind: 'xp', amount: 250 },
      ],
      pending: [],
      failed: [],
    },
    unlockedAt: SAMPLE_NOW,
    deadline: null,
    earnedCount: 3,
    timeZone: 'UTC',
    ...overrides,
  };
}

function message(input: unknown): AnnouncementMessage {
  return announcementMessageSchema.parse(input);
}

function render(
  kind: AchievementMessageKind,
  input: unknown,
  given: AchievementPlaceholderFacts = facts(),
) {
  const rendered = renderAchievementMessage(
    kind,
    message(input),
    given,
    SAMPLE_NOW,
    'announcement.message',
  );
  if (!rendered.ok) throw new Error(rendered.humanReason);
  return rendered;
}

function content(
  template: string,
  given: AchievementPlaceholderFacts = facts(),
  kind: AchievementMessageKind = 'unlocked',
): string | undefined {
  return render(kind, { content: template }, given).message.content;
}

function codes(template: string, given: AchievementPlaceholderFacts, kind: AchievementMessageKind) {
  return render(kind, { content: template }, given).diagnostics.map(({ code }) => code);
}

function config(input: AchievementsConfigInput = {}): AchievementsConfig {
  return achievementsConfigSchema.parse(input);
}

function achievement(overrides: Partial<AchievementInput> = {}): AchievementInput {
  return {
    id: 'chatterbox',
    name: 'Chatterbox',
    description: 'Talk a lot.',
    status: 'active',
    kind: 'tiered',
    requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
    tiers: [
      { id: 'bronze', targets: { msgs: 10 }, rewards: [{ kind: 'add_role', roleId: ROLE_A }] },
      { id: 'silver', targets: { msgs: 100 }, rewards: [{ kind: 'xp', amount: 50 }] },
      { id: 'gold', targets: { msgs: 1000 } },
    ],
    ...overrides,
  };
}

function keysOffered(kind: AchievementMessageKind, path: string): string[] {
  return ACHIEVEMENT_SURFACES[kind].pickerFor(path).map(({ key }) => key);
}

function blockingAt(report: TemplateReport): Array<[string, string]> {
  return report.blocking.map(({ path, diagnostic }) => [path, diagnostic.code]);
}

function codesAt(report: TemplateReport, path: string): string[] {
  return (report.byPath.get(path) ?? []).map(({ code }) => code);
}

describe('achievement surfaces', () => {
  test('four surfaces, each its own event, all in the module templates', () => {
    expect(Object.keys(achievementsTemplates.surfaces).sort()).toEqual([
      'achievements.almost_there',
      'achievements.almost_there_dm',
      'achievements.unlocked',
      'achievements.unlocked_dm',
    ]);

    for (const surface of Object.values(ACHIEVEMENT_SURFACES)) {
      expect(surface.event).toBe(surface.id);
      expect(surface.audience).toBe('public');
      expect(surface.samples.map(({ id }) => id)).toEqual(['achievement']);
    }
  });

  test('the unlock samples tell the SAMPLE_ACHIEVEMENT story', () => {
    const [sample] = ACHIEVEMENT_UNLOCKED_SURFACE.samples;
    const given = sample?.facts;

    expect(sample?.label).toBe('Sample: Fraimer earning Chatterbox (Gold) in Proton HQ');
    expect(given?.achievement).toEqual({ ...SAMPLE_ACHIEVEMENT.achievement });
    expect(given?.tier).toBe(SAMPLE_ACHIEVEMENT.tier);
    expect(given?.tiersUnlocked).toEqual([...SAMPLE_ACHIEVEMENT.tiersUnlocked]);
    expect(given?.requirements.map(({ current, target }) => [current, target])).toEqual(
      SAMPLE_ACHIEVEMENT.requirements.map(({ current, target }) => [current, target]),
    );
    expect(given?.rewards).toEqual({
      granted: [
        { kind: 'add_role', roleId: SAMPLE_ACHIEVEMENT.rewardRole.id, name: 'Regular' },
        { kind: 'xp', amount: 250 },
      ],
      pending: [],
      failed: [],
    });
    expect(given?.unlockedAt).toBe(SAMPLE_ACHIEVEMENT.unlockedAt);
    expect(given?.earnedCount).toBe(SAMPLE_ACHIEVEMENT.earnedCount);
    expect(given?.userId).toBe(SAMPLE_ACHIEVEMENT.member.user.id);
    expect(ACHIEVEMENT_UNLOCKED_DM_SURFACE.samples[0]?.facts.destinationChannel).toBeNull();
  });

  test('the almost there samples are the next tier, with no rewards', () => {
    const given = ACHIEVEMENT_ALMOST_THERE_SURFACE.samples[0]?.facts;

    expect(given?.tier).toBe(SAMPLE_ACHIEVEMENT.next.tier);
    expect(given?.requirements[0]?.target).toBe(SAMPLE_ACHIEVEMENT.next.target);
    expect(given?.rewards).toBeNull();
    expect(given?.unlockedAt).toBeNull();
    expect(ACHIEVEMENT_ALMOST_THERE_DM_SURFACE.samples[0]?.facts.destinationChannel).toBeNull();
  });

  test('each surface offers only what its destination and event can resolve', () => {
    const unlocked = keysOffered('unlocked', 'achievements.3.announcement.message.content');
    const unlockedDm = keysOffered('unlocked_dm', 'announcement.message.content');
    const almost = keysOffered('almost_there', 'almostThere.message.content');
    const almostDm = keysOffered('almost_there_dm', 'almostThere.message.content');

    expect(unlocked).toContain('rewards.summary');
    expect(unlocked).toContain('destination_channel.mention');
    expect(unlocked).toContain('channel.mention');
    expect(unlockedDm).toContain('rewards.granted_roles');
    expect(unlockedDm).toContain('channel.mention');
    expect(unlockedDm.some((key) => key.startsWith('destination_channel.'))).toBe(false);

    expect(almost).toContain('destination_channel.mention');
    expect(almost).toContain('progress.summary');
    for (const key of [
      'rewards.summary',
      'achievement.tiers_unlocked',
      'achievement.unlocked_at',
    ]) {
      expect(almost).not.toContain(key);
      expect(almostDm).not.toContain(key);
    }
    expect(almostDm.some((key) => key.startsWith('destination_channel.'))).toBe(false);
  });

  test('the unlock surfaces field the module and per-achievement messages, not almost there', () => {
    expect(ACHIEVEMENT_UNLOCKED_SURFACE.fieldAt('announcement.message.content')).toBeDefined();
    expect(
      ACHIEVEMENT_UNLOCKED_DM_SURFACE.fieldAt('achievements.0.announcement.message.embeds.1.title'),
    ).toBeDefined();
    expect(ACHIEVEMENT_UNLOCKED_SURFACE.fieldAt('almostThere.message.content')).toBeUndefined();
    expect(ACHIEVEMENT_ALMOST_THERE_SURFACE.fieldAt('almostThere.message.content')).toBeDefined();
    expect(
      ACHIEVEMENT_ALMOST_THERE_SURFACE.fieldAt('announcement.message.content'),
    ).toBeUndefined();
  });

  test('rewards.summary is message text only', () => {
    const footer = keysOffered('unlocked', 'announcement.message.embeds.0.footer.text');

    expect(footer).not.toContain('rewards.summary');
    expect(footer).toContain('rewards.granted_xp');
  });

  test('reward roles warn about pings on channel surfaces only', () => {
    expect(ACHIEVEMENT_UNLOCKED_SURFACE.pings['rewards.granted_roles']).toBe('roles');
    expect(ACHIEVEMENT_UNLOCKED_SURFACE.pings['rewards.failed_roles']).toBe('roles');
    expect(ACHIEVEMENT_UNLOCKED_DM_SURFACE.pings).toEqual({});
    expect(ACHIEVEMENT_ALMOST_THERE_DM_SURFACE.pings).toEqual({});
  });

  test('{user} is the member mention', () => {
    expect(content('{user}')).toBe(`<@${USER}>`);
  });
});

describe('renderAchievementMessage', () => {
  test('fills in every achievement key', () => {
    expect(
      content(
        '{achievement.name}|{achievement.description}|{achievement.tier}|' +
          '{achievement.tier_label}|{achievement.tier_number}|{achievement.tier_count}|' +
          '{achievement.badge}|{achievement.tiers_unlocked}|{achievement.unlocked_at}|' +
          '{achievement.deadline}|{achievement.earned_count}',
      ),
    ).toBe(
      'Chatterbox|**Talk** a lot|Silver|(Silver)|2|4|🥈|Bronze and Silver|<t:1789376400:f>||3',
    );
  });

  test('fills in the progress keys from the requirement furthest from done', () => {
    const given = facts({
      requirements: [
        {
          trigger: 'messages.sent',
          label: 'Send 500 messages',
          current: 320,
          target: 500,
          unit: MESSAGES,
        },
        {
          trigger: 'voice.minutes',
          label: 'Spend 60 minutes in voice',
          current: 45,
          target: 60,
          unit: VOICE,
        },
      ],
    });

    expect(
      content(
        '{requirement.summary}|{progress.current}|{progress.target}|{progress.remaining}|' +
          '{progress.percent}|{progress.unit}|{progress.summary}',
        given,
        'almost_there',
      ),
    ).toBe(
      'Send 500 messages and spend 60 minutes in voice|320|500|180|64%|messages|' +
        '320 / 500 messages, 45 / 60 voice minutes',
    );
  });

  test('fills in the reward keys, and never lists a failed reward as given', () => {
    const given = facts({
      rewards: {
        granted: [
          { kind: 'add_role', roleId: ROLE_A },
          { kind: 'xp', amount: 250 },
        ],
        pending: [{ kind: 'xp', amount: 50 }],
        failed: [{ kind: 'add_role', roleId: ROLE_B }],
      },
    });

    expect(
      content(
        '{rewards.granted_roles}|{rewards.pending_roles}|{rewards.failed_roles}|' +
          '{rewards.granted_xp}|{rewards.pending_xp}|{rewards.summary}',
        given,
      ),
    ).toBe(
      `<@&${ROLE_A}>||<@&${ROLE_B}>|250|50|<@&${ROLE_A}> and 250 XP given; 50 XP still on its way`,
    );
  });

  test('a summary of only failed rewards is empty, not a list of them', () => {
    const given = facts({
      rewards: {
        granted: [],
        pending: [],
        failed: [
          { kind: 'add_role', roleId: ROLE_A },
          { kind: 'xp', amount: 100 },
        ],
      },
    });

    expect(content('[{rewards.summary}]', given)).toBe('[]');
    expect(codes('{rewards.summary}', given, 'unlocked')).toEqual(['not_set']);
    expect(content('{rewards.granted_roles}|{rewards.granted_xp}', given)).toBe('|0');
  });

  test('the summary says what was removed and what is still coming', () => {
    const given = facts({
      rewards: {
        granted: [{ kind: 'remove_role', roleId: ROLE_B }],
        pending: [
          { kind: 'add_role', roleId: ROLE_A },
          { kind: 'xp', amount: 1500 },
          { kind: 'remove_role', roleId: CHANNEL },
        ],
        failed: [],
      },
    });

    expect(content('{rewards.summary}', given)).toBe(
      `<@&${ROLE_B}> removed; <@&${ROLE_A}> and 1,500 XP still on their way; ` +
        `<@&${CHANNEL}> still to be removed`,
    );
  });

  test('channel and destination channel', () => {
    expect(content('{channel.mention} {destination_channel.mention}')).toBe(
      `<#${CHANNEL}> <#${OTHER_CHANNEL}>`,
    );
  });

  describe('absent states', () => {
    test('an unlock outside a channel leaves channel.* empty as not set', () => {
      const given = facts({ originChannel: null });

      expect(content('[{channel.mention}{channel.name}]', given)).toBe('[]');
      expect(codes('{channel.mention}', given, 'unlocked')).toEqual(['not_set']);
    });

    test('no destination channel is unavailable', () => {
      expect(
        codes('{destination_channel.name}', facts({ destinationChannel: null }), 'unlocked'),
      ).toEqual(['unavailable']);
    });

    test('an uncounted collection, a missing deadline and missing rewards', () => {
      const given = facts({ earnedCount: null, rewards: null });

      expect(codes('{achievement.earned_count}', given, 'unlocked')).toEqual(['unavailable']);
      expect(codes('{achievement.deadline}', given, 'unlocked')).toEqual(['not_set']);
      expect(codes('{rewards.granted_roles}', given, 'unlocked')).toEqual(['unavailable']);
      expect(content('{achievement.deadline}', facts({ deadline: SAMPLE_NOW + 1000 }))).toBe(
        '<t:1789376401:f>',
      );
    });

    test('an achievement without tiers', () => {
      const given = facts({
        tier: 'single',
        tiersUnlocked: ['single'],
        achievement: { id: 'hello', name: 'Hello', description: '', kind: 'single', tierCount: 1 },
      });

      expect(
        content(
          '{achievement.tier}|{achievement.tier_label}|{achievement.tier_number}|' +
            '{achievement.badge}|{achievement.tiers_unlocked}|{achievement.description}',
          given,
        ),
      ).toBe('Earned||1|🏅|Earned|');
    });

    test('a profile Proton could not read still mentions the member', () => {
      expect(content('{user.mention} {user.id}', facts({ user: null }))).toBe(`<@${USER}> ${USER}`);
    });

    test('no readable requirement', () => {
      expect(codes('{progress.summary}', facts({ requirements: [] }), 'unlocked')).toEqual([
        'unavailable',
      ]);
    });
  });

  test('a DM surface refuses destination_channel.*', () => {
    const given = facts();

    expect(content('[{destination_channel.mention}]', given, 'unlocked_dm')).toBe('[]');
    expect(codes('{destination_channel.mention}', given, 'unlocked_dm')).toEqual(['unavailable']);
    expect(codes('{destination_channel.id}', given, 'almost_there_dm')).toEqual(['unavailable']);

    const checked = validateTemplate('{destination_channel.mention}', {
      registry: ACHIEVEMENT_UNLOCKED_DM_SURFACE.registry,
      field: 'discord_text',
      event: ACHIEVEMENT_UNLOCKED_DM_SURFACE.event,
      audience: 'public',
    });
    expect(checked.diagnostics.map(({ code, severity }) => [code, severity])).toEqual([
      ['unavailable', 'error'],
    ]);
  });

  test('almost there surfaces refuse the unlock-only keys', () => {
    for (const key of ['rewards.summary', 'rewards.granted_xp', 'achievement.unlocked_at']) {
      expect(codes(`{${key}}`, facts({ rewards: null, unlockedAt: null }), 'almost_there')).toEqual(
        ['unavailable'],
      );
    }
  });

  test('plain-text dates follow the module time zone', () => {
    const footer = (timeZone: string) =>
      render(
        'unlocked',
        {
          embeds: [{ description: 'x', footer: { text: '{achievement.unlocked_at}' } }],
        },
        facts({ timeZone }),
      ).message.embeds[0]?.footer?.text ?? '';

    expect(footer('UTC')).toMatch(/^Sep 14, 2026, 9:00\sAM$/);
    expect(footer('Asia/Tokyo')).toMatch(/^Sep 14, 2026, 6:00\sPM$/);
  });

  test('member-controlled text is escaped and the description keeps its formatting', () => {
    const given = facts({
      achievement: {
        id: 'x',
        name: '*Star*',
        description: '__bold__',
        kind: 'single',
        tierCount: 1,
      },
    });

    expect(content('{achievement.name} {achievement.description}', given)).toBe(
      '\\*Star\\* __bold__',
    );
  });

  test('usedAchievementKeys lists only keys the surface allows', () => {
    const keys = usedAchievementKeys(
      'almost_there_dm',
      message({ content: '{achievement.earned_count} {rewards.summary} {user}' }),
    );

    expect([...keys].sort()).toEqual(['achievement.earned_count', 'user.mention']);
  });
});

describe('achievementsTemplates', () => {
  const next = config({
    announcement: {
      destination: 'channel',
      channelId: CHANNEL,
      message: {
        content: '{rewards.granted_roles} {destination_channel.mention}',
        mentions: { everyone: false, roles: true, users: true },
      },
    },
    almostThere: {
      destination: 'dm',
      message: { content: '{rewards.summary} {progress.summary}' },
    },
    achievements: [
      achievement({
        announcement: {
          mode: 'custom',
          destination: 'dm',
          message: {
            content: 'In {destination_channel.mention}: {rewards.granted_roles}',
            mentions: { everyone: false, roles: true, users: true },
          },
        },
      }),
      achievement({
        id: 'regular',
        name: 'Regular',
        announcement: {
          mode: 'custom',
          destination: 'channel',
          channelId: OTHER_CHANNEL,
          message: { content: '{destination_channel.mention} {rewards.summary}' },
        },
      }),
      achievement({
        id: 'talker',
        name: 'Talker',
        announcement: { mode: 'default', message: { content: '{destination_channel.name}' } },
      }),
    ],
  });

  test('collect routes every site to each surface its destination can reach', () => {
    const sites = achievementsTemplates
      .collect(next)
      .map(({ path, surfaceId }) => [path, surfaceId]);

    expect(sites).toEqual([
      ['announcement.message.content', 'achievements.unlocked'],
      ['achievements.1.announcement.message.content', 'achievements.unlocked'],
      ['achievements.2.announcement.message.content', 'achievements.unlocked'],
      ['achievements.0.announcement.message.content', 'achievements.unlocked_dm'],
      ['almostThere.message.content', 'achievements.almost_there_dm'],
    ]);
  });

  test('a new custom message is refused where its destination cannot resolve a key', () => {
    const report = validateConfigTemplates(achievementsTemplates, next, achievementsDefaultConfig);

    expect(blockingAt(report).sort()).toEqual([
      ['achievements.0.announcement.message.content', 'unavailable'],
      ['almostThere.message.content', 'unavailable'],
    ]);
  });

  test('ping warnings follow the destination', () => {
    const report = validateConfigTemplates(achievementsTemplates, next);

    expect(codesAt(report, 'announcement.message.content')).toEqual(['may_ping']);
    expect(codesAt(report, 'achievements.0.announcement.message.content')).toEqual(['unavailable']);
    expect(codesAt(report, 'achievements.1.announcement.message.content')).toEqual([]);
  });

  test('saved text never blocks another save', () => {
    expect(validateConfigTemplates(achievementsTemplates, next, next).blocking).toEqual([]);
  });

  test('the defaults are valid on the surfaces they land on', () => {
    expect(
      validateConfigTemplates(achievementsTemplates, achievementsDefaultConfig, {}).blocking,
    ).toEqual([]);
    expect(
      achievementsTemplates.collect(achievementsDefaultConfig).map(({ surfaceId }) => surfaceId),
    ).toEqual(['achievements.unlocked', 'achievements.almost_there_dm']);
  });

  test('a fallback direct message refuses the destination channel too', () => {
    const fallback = config({
      announcement: {
        destination: 'current',
        fallback: 'dm',
        message: { content: 'earned in {destination_channel.mention}' },
      },
      achievements: [
        achievement({
          announcement: { mode: 'custom', message: { content: '{destination_channel.name}' } },
        }),
      ],
    });

    expect(
      achievementsTemplates.collect(fallback).map(({ path, surfaceId }) => [path, surfaceId]),
    ).toEqual([
      ['announcement.message.content', 'achievements.unlocked'],
      ['achievements.0.announcement.message.content', 'achievements.unlocked'],
      ['announcement.message.content', 'achievements.unlocked_dm'],
      ['achievements.0.announcement.message.content', 'achievements.unlocked_dm'],
      ['almostThere.message.content', 'achievements.almost_there_dm'],
    ]);
    expect(
      blockingAt(
        validateConfigTemplates(achievementsTemplates, fallback, achievementsDefaultConfig),
      ).sort(),
    ).toEqual([
      ['achievements.0.announcement.message.content', 'unavailable'],
      ['announcement.message.content', 'unavailable'],
    ]);
  });

  test('an override with no destination of its own is validated where the module sends', () => {
    const inherited = config({
      announcement: { destination: 'dm' },
      achievements: [
        achievement({
          announcement: {
            mode: 'custom',
            message: { content: 'In {destination_channel.mention}' },
          },
        }),
      ],
    });

    expect(achievementsTemplates.collect(inherited).map(({ surfaceId }) => surfaceId)).toEqual([
      'achievements.unlocked_dm',
      'achievements.unlocked_dm',
      'achievements.almost_there_dm',
    ]);
    expect(
      blockingAt(
        validateConfigTemplates(achievementsTemplates, inherited, achievementsDefaultConfig),
      ),
    ).toEqual([['achievements.0.announcement.message.content', 'unavailable']]);
  });

  test('a module DM announcement refuses the destination channel', () => {
    const dm = config({
      announcement: { destination: 'dm', message: { content: 'See {destination_channel.name}' } },
    });

    expect(
      blockingAt(validateConfigTemplates(achievementsTemplates, dm, achievementsDefaultConfig)),
    ).toEqual([['announcement.message.content', 'unavailable']]);
  });

  test('collect survives anything', () => {
    for (const garbage of [null, 7, 'x', [], { achievements: 'no' }, { announcement: [] }]) {
      expect(achievementsTemplates.collect(garbage)).toEqual([]);
    }
  });
});

describe('routes', () => {
  const routed = config({
    announcement: { destination: 'channel', channelId: CHANNEL },
    achievements: [
      achievement(),
      achievement({
        id: 'dm-one',
        announcement: { mode: 'custom', destination: 'dm', message: { content: 'hi' } },
      }),
      achievement({ id: 'quiet', announcement: { mode: 'off' } }),
      achievement({
        id: 'elsewhere',
        announcement: { mode: 'custom', destination: 'channel', channelId: OTHER_CHANNEL },
      }),
    ],
  });

  const find = (id: string) => routed.achievements.find((candidate) => candidate.id === id) ?? null;

  test('default and sample use the module announcement', () => {
    for (const subject of [null, find('chatterbox')]) {
      expect(unlockRoute(routed, subject)).toEqual({
        kind: 'unlocked',
        destination: 'channel',
        channelId: CHANNEL,
        message: routed.announcement.message,
        basePath: 'announcement.message',
      });
    }
  });

  test('a custom achievement uses its own destination and message path', () => {
    expect(unlockRoute(routed, find('dm-one'))).toMatchObject({
      kind: 'unlocked_dm',
      destination: 'dm',
      channelId: null,
      basePath: 'achievements.1.announcement.message',
    });
    expect(unlockRoute(routed, find('quiet'))).toBeNull();
    expect(unlockRoute(routed, find('elsewhere'))).toMatchObject({
      kind: 'unlocked',
      channelId: OTHER_CHANNEL,
      basePath: 'announcement.message',
    });
  });

  test('almost there', () => {
    expect(almostThereRoute(routed)).toMatchObject({
      kind: 'almost_there_dm',
      destination: 'dm',
      channelId: null,
      basePath: 'almostThere.message',
    });
  });
});

describe('toSendBody', () => {
  const linked = message({
    content: 'Well done {user}',
    embeds: [{ description: 'x' }],
    components: [
      {
        kind: 'buttons',
        buttons: [{ key: 'more', style: 'link', label: 'More', url: 'https://prtn.xyz' }],
      },
    ],
    mentions: { everyone: false, roles: true, users: true },
  });

  test('a channel send keeps the stored mention policy, a DM pings nobody', () => {
    expect(toSendBody('unlocked', linked, SAMPLE_NOW).allowedMentions).toEqual({
      parse: ['roles', 'users'],
    });
    expect(toSendBody('unlocked_dm', linked, SAMPLE_NOW).allowedMentions).toEqual({ parse: [] });
    expect(toSendBody('almost_there_dm', linked, SAMPLE_NOW).allowedMentions).toEqual({
      parse: [],
    });
  });

  test('link buttons need no custom id', () => {
    expect(toSendBody('unlocked', linked, SAMPLE_NOW).components).toHaveLength(1);
  });

  test('the badge becomes the first embed thumbnail only when it has none', () => {
    const badged = toSendBody('unlocked', withBadgeThumbnail(linked), SAMPLE_NOW);
    expect(badged.embeds?.[0]?.thumbnail).toEqual({ url: 'attachment://badge.png' });

    const own = message({ embeds: [{ description: 'x', thumbnailUrl: 'https://prtn.xyz/a.png' }] });
    expect(withBadgeThumbnail(own)).toBe(own);

    const plain = message({ content: 'x' });
    expect(withBadgeThumbnail(plain)).toBe(plain);
  });
});

describe('previewFacts', () => {
  const tried = config({
    timezone: 'Europe/London',
    achievements: [
      achievement({ endsAt: '2026-12-31T23:00:00.000Z' }),
      achievement({
        id: 'follower',
        name: 'Follower',
        kind: 'single',
        requirements: [
          {
            id: 'earned',
            trigger: 'achievements.unlocked',
            achievementId: 'chatterbox',
            tierId: 'silver',
          },
        ],
        tiers: [{ id: 'single', targets: { earned: 1 } }],
      }),
    ],
  });

  const chatterbox = tried.achievements[0] ?? null;

  test('the sample path gives the surface samples', () => {
    for (const kind of ['unlocked', 'unlocked_dm', 'almost_there', 'almost_there_dm'] as const) {
      expect(previewFacts(achievementsDefaultConfig, null, { kind, now: SAMPLE_NOW })).toEqual(
        ACHIEVEMENT_SURFACES[kind].samples[0]?.facts as AchievementPlaceholderFacts,
      );
    }
  });

  test('try-it values pick the highest tier earned and its rewards', () => {
    const given = previewFacts(tried, chatterbox, {
      kind: 'unlocked',
      now: SAMPLE_NOW,
      values: { msgs: 150 },
    });

    expect(given.tier).toBe('silver');
    expect(given.tiersUnlocked).toEqual(['bronze', 'silver']);
    expect(given.requirements).toEqual([
      {
        trigger: 'messages.sent',
        label: 'Send 100 messages',
        current: 150,
        target: 100,
        unit: MESSAGES,
      },
    ]);
    expect(given.rewards).toEqual({
      granted: [{ kind: 'xp', amount: 50 }],
      pending: [],
      failed: [],
    });
    expect(given.deadline).toBe(Date.parse('2026-12-31T23:00:00.000Z'));
    expect(given.timeZone).toBe('Europe/London');
    expect(given.achievement.tierCount).toBe(3);
  });

  test('try-it values pick the next tier for almost there', () => {
    const given = previewFacts(tried, chatterbox, {
      kind: 'almost_there',
      now: SAMPLE_NOW,
      values: { msgs: 60 },
    });

    expect(given.tier).toBe('silver');
    expect(given.tiersUnlocked).toEqual(['bronze']);
    expect(given.requirements[0]).toMatchObject({ current: 60, target: 100 });
    expect(given.rewards).toBeNull();
    expect(given.unlockedAt).toBeNull();
  });

  test('a tier the achievement lacks uses the highest one below it', () => {
    expect(
      previewFacts(tried, chatterbox, { kind: 'unlocked', now: SAMPLE_NOW, tier: 'diamond' }).tier,
    ).toBe('gold');
  });

  test('percent sets almost there progress, and rewards pick their state', () => {
    const almost = previewFacts(tried, chatterbox, {
      kind: 'almost_there',
      now: SAMPLE_NOW,
      tier: 'gold',
      percent: 90,
    });
    expect(almost.requirements[0]).toMatchObject({ current: 900, target: 1000 });

    const pending = previewFacts(tried, chatterbox, {
      kind: 'unlocked',
      now: SAMPLE_NOW,
      tier: 'bronze',
      rewards: 'pending',
      roleNames: { [ROLE_A]: 'Chatty' },
    });
    expect(pending.rewards).toEqual({
      granted: [],
      pending: [{ kind: 'add_role', roleId: ROLE_A, name: 'Chatty' }],
      failed: [],
    });
  });

  test('prerequisites are described by name, and DMs have no destination channel', () => {
    const given = previewFacts(tried, tried.achievements[1] ?? null, {
      kind: 'unlocked_dm',
      now: SAMPLE_NOW,
    });

    expect(given.tier).toBe('single');
    expect(given.requirements[0]?.label).toBe('Earn Chatterbox (Silver or higher)');
    expect(given.destinationChannel).toBeNull();
    expect(given.originChannel).not.toBeNull();
  });

  test('what a surface offers matches what definitionsFor offers', () => {
    const surface = ACHIEVEMENT_UNLOCKED_DM_SURFACE;
    expect(surface.pickerFor('announcement.message.content')).toEqual(
      definitionsFor(surface.registry, {
        field: 'discord_text',
        event: surface.event,
        audience: 'public',
      }),
    );
  });
});
