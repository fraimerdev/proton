import { describe, expect, test } from 'bun:test';
import {
  ACHIEVEMENTS_CEILING,
  achievementSchema,
  achievementsConfigSchema,
  achievementsDefaultConfig,
  achievementsFormSchema,
  DEFAULT_ALMOST_THERE,
  DEFAULT_ANNOUNCEMENT,
  requirementSchema,
} from '../src/config.ts';

const CHATTERBOX = {
  id: 'chatterbox',
  name: 'Chatterbox',
  kind: 'single',
  requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
  tiers: [{ id: 'single', targets: { msgs: 10 } }],
} as const;

function messages(path: string, value: unknown): string[] {
  const parsed = achievementsConfigSchema.safeParse({ [path]: value });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('achievementsConfigSchema', () => {
  test('parse({}) yields every nested object fully populated', () => {
    expect(achievementsConfigSchema.parse({})).toEqual({
      enabled: false,
      timezone: 'UTC',
      excludedChannelIds: [],
      excludedRoleIds: [],
      messageCooldown: '15s',
      announcement: {
        destination: 'current',
        fallback: 'none',
        attachBadge: true,
        message: DEFAULT_ANNOUNCEMENT,
      },
      almostThere: { destination: 'dm', cooldown: '1d', message: DEFAULT_ALMOST_THERE },
      achievements: [],
    });
  });

  test('the default config is what an empty object parses to', () => {
    expect(achievementsDefaultConfig).toEqual(achievementsConfigSchema.parse({}));
  });

  test('default announcements ping the member and never roles or everyone', () => {
    for (const message of [DEFAULT_ANNOUNCEMENT, DEFAULT_ALMOST_THERE]) {
      expect(message.mentions).toEqual({ everyone: false, roles: false, users: true });
    }
  });

  test('an achievement fills its badge, almost-there and announcement objects', () => {
    const achievement = achievementSchema.parse(CHATTERBOX);

    expect(achievement.status).toBe('draft');
    expect(achievement.description).toBe('');
    expect(achievement.badge).toEqual({ shape: 'circle', icon: 'trophy', colour: 'tier' });
    expect(achievement.almostThere).toEqual({ enabled: false, percent: 80 });
    expect(achievement.announcement).toEqual({ mode: 'default' });
    expect(achievement.includeRecorded).toBe(false);
    expect(achievement.roleIds).toEqual([]);
    expect(achievement.excludedRoleIds).toEqual([]);
    expect(achievement.tiers[0]?.rewards).toEqual([]);
  });

  test('a requirement without xpSources stays without it', () => {
    const requirement = requirementSchema.parse({ id: 'msgs', trigger: 'messages.sent' });
    expect('xpSources' in requirement).toBe(false);
    expect(requirement.version).toBe(1);
    expect(requirement.channelIds).toEqual([]);

    const config = achievementsConfigSchema.parse({ achievements: [CHATTERBOX] });
    expect('xpSources' in (config.achievements[0]?.requirements[0] ?? {})).toBe(false);

    const xp = requirementSchema.parse({ id: 'xp', trigger: 'leveling.activity_xp' });
    expect(xp.xpSources).toBeUndefined();
  });

  test('chosen XP sources are kept', () => {
    const requirement = requirementSchema.parse({
      id: 'xp',
      trigger: 'leveling.activity_xp',
      xpSources: ['message', 'reward'],
    });
    expect(requirement.xpSources).toEqual(['message', 'reward']);
  });

  test('the message cooldown runs from 0s to 1h', () => {
    expect(messages('messageCooldown', '0s')).toEqual([]);
    expect(messages('messageCooldown', '1h')).toEqual([]);
    expect(messages('messageCooldown', '61m')).toEqual(['must be between 0s and 1h']);
    expect(messages('messageCooldown', 'soon')).toHaveLength(1);
  });

  test('the almost-there cooldown runs from 1h to 30d', () => {
    const cooldown = (value: string) =>
      achievementsConfigSchema.safeParse({ almostThere: { cooldown: value } }).success;

    expect(cooldown('1h')).toBe(true);
    expect(cooldown('30d')).toBe(true);
    expect(cooldown('59m')).toBe(false);
    expect(cooldown('31d')).toBe(false);
  });

  test('the time zone must be one Intl knows', () => {
    expect(messages('timezone', 'Europe/London')).toEqual([]);
    expect(messages('timezone', 'Mars/Olympus')).toEqual(['Pick a time zone from the list.']);
  });

  test('an empty announcement is a silent one, not an error', () => {
    const silent = { content: '', embeds: [], components: [], v2: [] };
    expect(achievementsConfigSchema.safeParse({ announcement: { message: silent } }).success).toBe(
      true,
    );
  });

  test('announcements refuse buttons nobody would answer', () => {
    const pressable = {
      content: 'Well done',
      components: [
        { kind: 'buttons', buttons: [{ key: 'claim', style: 'primary', label: 'Claim' }] },
      ],
    };

    const parsed = achievementsConfigSchema.safeParse({ announcement: { message: pressable } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      'Only link buttons can be used here.',
    );
  });

  test('almost-there percent runs from 50 to 95', () => {
    const percent = (value: number) =>
      achievementSchema.safeParse({ ...CHATTERBOX, almostThere: { enabled: true, percent: value } })
        .success;

    expect(percent(50)).toBe(true);
    expect(percent(95)).toBe(true);
    expect(percent(49)).toBe(false);
    expect(percent(96)).toBe(false);
  });

  test('ids follow their patterns', () => {
    expect(achievementSchema.safeParse({ ...CHATTERBOX, id: 'ab' }).success).toBe(false);
    expect(achievementSchema.safeParse({ ...CHATTERBOX, id: 'Chatter' }).success).toBe(false);
    expect(requirementSchema.safeParse({ id: '-x', trigger: 'messages.sent' }).success).toBe(false);
    expect(
      requirementSchema.safeParse({ id: 'a'.repeat(17), trigger: 'messages.sent' }).success,
    ).toBe(false);
  });

  test('the list is capped at the highest tier’s limit', () => {
    const many = Array.from({ length: ACHIEVEMENTS_CEILING + 1 }, (_, index) => ({
      ...CHATTERBOX,
      id: `a${String(index).padStart(3, '0')}`,
    }));
    expect(achievementsConfigSchema.safeParse({ achievements: many }).success).toBe(false);
  });

  test('the form schema holds the five general settings', () => {
    expect(Object.keys(achievementsFormSchema.shape).sort()).toEqual([
      'enabled',
      'excludedChannelIds',
      'excludedRoleIds',
      'messageCooldown',
      'timezone',
    ]);
  });
});
