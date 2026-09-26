import { describe, expect, test } from 'bun:test';
import type { ConfigWriteIssue, TierId } from '@proton/core';
import {
  type AchievementInput,
  type AchievementsConfigInput,
  achievementsConfigSchema,
} from '../src/config.ts';
import { VERSION_CHANGED, validateConfig } from '../src/validate.ts';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const ROLE_A = '400000000000000001';
const ROLE_B = '400000000000000002';
const CHANNEL = '300000000000000001';

function single(id: string, overrides: Partial<AchievementInput> = {}): AchievementInput {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    kind: 'single',
    requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
    tiers: [{ id: 'single', targets: { msgs: 10 } }],
    ...overrides,
  };
}

function tiered(id: string, overrides: Partial<AchievementInput> = {}): AchievementInput {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    kind: 'tiered',
    requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
    tiers: [
      { id: 'bronze', targets: { msgs: 10 } },
      { id: 'silver', targets: { msgs: 50 } },
    ],
    ...overrides,
  };
}

function pointer(id: string, target: string, tierId?: TierId) {
  return single(id, {
    requirements: [
      {
        id: 'held',
        trigger: 'achievements.unlocked',
        achievementId: target,
        ...(tierId !== undefined ? { tierId } : {}),
      },
    ],
    tiers: [{ id: 'single', targets: { held: 1 } }],
  });
}

function check(
  achievements: AchievementInput[],
  options: {
    before?: AchievementInput[];
    module?: Omit<AchievementsConfigInput, 'achievements'>;
  } = {},
): ConfigWriteIssue[] {
  const next = achievementsConfigSchema.parse({ ...options.module, achievements });
  const before = achievementsConfigSchema.parse({ achievements: options.before ?? [] });
  return validateConfig(next, before, NOW);
}

function paths(issues: ConfigWriteIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

describe('validateConfig', () => {
  test('a well-formed single and tiered achievement pass', () => {
    expect(check([single('chatterbox'), tiered('regular')])).toEqual([]);
  });

  describe('1. ids', () => {
    test('achievement ids are unique', () => {
      const issues = check([single('chatterbox'), single('chatterbox')]);
      expect(paths(issues)).toEqual(['achievements.1.id']);
      expect(issues[0]?.message).toBe('Another achievement already uses the ID “chatterbox”.');
    });

    test('requirement ids are unique within an achievement', () => {
      const issues = check([
        single('chatterbox', {
          requirements: [
            { id: 'msgs', trigger: 'messages.sent' },
            { id: 'msgs', trigger: 'voice.minutes' },
          ],
        }),
      ]);
      expect(paths(issues)).toContain('achievements.0.requirements.1.id');
    });
  });

  describe('2. shape', () => {
    test('a single achievement has exactly the one single tier', () => {
      expect(
        paths(check([single('solo', { tiers: [{ id: 'bronze', targets: { msgs: 1 } }] })])),
      ).toEqual(['achievements.0.tiers']);

      const twice = single('solo', {
        tiers: [
          { id: 'single', targets: { msgs: 1 } },
          { id: 'single', targets: { msgs: 2 } },
        ],
      });
      expect(paths(check([twice]))).toEqual(['achievements.0.tiers']);
    });

    test('a tiered achievement has 2 to 4 tiers in order', () => {
      const lonely = tiered('ladder', { tiers: [{ id: 'bronze', targets: { msgs: 1 } }] });
      expect(paths(check([lonely]))).toEqual(['achievements.0.tiers']);

      const shuffled = tiered('ladder', {
        tiers: [
          { id: 'silver', targets: { msgs: 1 } },
          { id: 'bronze', targets: { msgs: 2 } },
        ],
      });
      expect(paths(check([shuffled]))).toContain('achievements.0.tiers');

      const skipping = tiered('ladder', {
        tiers: [
          { id: 'bronze', targets: { msgs: 1 } },
          { id: 'gold', targets: { msgs: 2 } },
        ],
      });
      expect(paths(check([skipping]))).toEqual(['achievements.0.tiers']);

      const full = tiered('ladder', {
        tiers: [
          { id: 'bronze', targets: { msgs: 1 } },
          { id: 'silver', targets: { msgs: 2 } },
          { id: 'gold', targets: { msgs: 3 } },
          { id: 'diamond', targets: { msgs: 4 } },
        ],
      });
      expect(check([full])).toEqual([]);
    });

    test('a tiered achievement has exactly one requirement', () => {
      const combined = tiered('ladder', {
        requirements: [
          { id: 'msgs', trigger: 'messages.sent' },
          { id: 'voice', trigger: 'voice.minutes' },
        ],
        tiers: [
          { id: 'bronze', targets: { msgs: 1, voice: 1 } },
          { id: 'silver', targets: { msgs: 2, voice: 2 } },
        ],
      });
      const issues = check([combined]);
      expect(paths(issues)).toEqual(['achievements.0.requirements']);
      expect(issues[0]?.message).toContain('exactly one requirement');
    });

    test('a tiered achievement’s requirement must be a tierable trigger', () => {
      const ladder = tiered('ladder', {
        requirements: [{ id: 'held', trigger: 'achievements.unlocked', achievementId: 'other' }],
        tiers: [
          { id: 'bronze', targets: { held: 1 } },
          { id: 'silver', targets: { held: 1 } },
        ],
      });
      const issues = check([ladder, single('other')]);
      expect(paths(issues)).toContain('achievements.0.requirements.0.trigger');
      expect(issues.find((issue) => issue.path.endsWith('.trigger'))?.message).toBe(
        '“Earn a specific achievement” can’t be tiered. Use it in a single achievement.',
      );
    });
  });

  describe('3. targets', () => {
    test('every tier targets every requirement', () => {
      const missing = single('combo', {
        requirements: [
          { id: 'msgs', trigger: 'messages.sent' },
          { id: 'voice', trigger: 'voice.minutes' },
        ],
        tiers: [{ id: 'single', targets: { msgs: 10 } }],
      });
      const issues = check([missing]);
      expect(paths(issues)).toEqual(['achievements.0.tiers.0.targets.voice']);
      expect(issues[0]?.message).toBe('This achievement needs a target for “Spend time in voice”.');
    });

    test('a target for no requirement is refused', () => {
      const stray = single('combo', { tiers: [{ id: 'single', targets: { msgs: 10, ghost: 3 } }] });
      expect(paths(check([stray]))).toEqual(['achievements.0.tiers.0.targets.ghost']);
    });

    test('targets stay inside the trigger’s bounds', () => {
      const long = single('marathon', {
        requirements: [{ id: 'stay', trigger: 'voice.longest_stay' }],
        tiers: [{ id: 'single', targets: { stay: 2000 } }],
      });
      const issues = check([long]);
      expect(paths(issues)).toEqual(['achievements.0.tiers.0.targets.stay']);
      expect(issues[0]?.message).toBe('Targets for “Stay in voice in one go” go from 1 to 1,440.');
    });
  });

  describe('4. strict increase', () => {
    test('each tier needs more than the one below', () => {
      const flat = tiered('ladder', {
        tiers: [
          { id: 'bronze', targets: { msgs: 50 } },
          { id: 'silver', targets: { msgs: 50 } },
          { id: 'gold', targets: { msgs: 40 } },
        ],
      });
      const issues = check([flat]);
      expect(paths(issues)).toEqual([
        'achievements.0.tiers.1.targets.msgs',
        'achievements.0.tiers.2.targets.msgs',
      ]);
      expect(issues[0]?.message).toBe('Silver needs more than Bronze.');
      expect(issues[1]?.message).toBe('Gold needs more than Silver.');
    });
  });

  describe('5. rewards', () => {
    function rewarded(rewards: NonNullable<AchievementInput['tiers'][number]['rewards']>) {
      return single('generous', { tiers: [{ id: 'single', targets: { msgs: 10 }, rewards }] });
    }

    test('a reward is listed once per tier', () => {
      const issues = check([
        rewarded([
          { kind: 'add_role', roleId: ROLE_A },
          { kind: 'add_role', roleId: ROLE_A },
        ]),
      ]);
      expect(paths(issues)).toEqual(['achievements.0.tiers.0.rewards.1']);
      expect(issues[0]?.message).toBe('This reward is already in this tier.');
    });

    test('giving and removing the same role is contradictory', () => {
      const issues = check([
        rewarded([
          { kind: 'add_role', roleId: ROLE_A },
          { kind: 'remove_role', roleId: ROLE_A },
        ]),
      ]);
      expect(paths(issues)).toEqual(['achievements.0.tiers.0.rewards.1']);
      expect(issues[0]?.message).toContain('can’t both give and remove the same role');
    });

    test('a tier gives XP at most once', () => {
      const issues = check([
        rewarded([
          { kind: 'xp', amount: 100 },
          { kind: 'xp', amount: 50 },
        ]),
      ]);
      expect(paths(issues)).toEqual(['achievements.0.tiers.0.rewards.1']);
      expect(issues[0]?.message).toBe('A tier gives XP once. Add the amounts together instead.');
    });

    test('different roles and one XP reward are fine', () => {
      const issues = check([
        rewarded([
          { kind: 'remove_role', roleId: ROLE_B },
          { kind: 'add_role', roleId: ROLE_A },
          { kind: 'xp', amount: 250 },
        ]),
      ]);
      expect(issues).toEqual([]);
    });
  });

  describe('6. filters', () => {
    function withRequirement(requirement: AchievementInput['requirements'][number]) {
      return single('filtered', {
        requirements: [requirement],
        tiers: [{ id: 'single', targets: { [requirement.id]: 5 } }],
      });
    }

    test('channel filters only where the trigger counts channels', () => {
      expect(
        check([withRequirement({ id: 'msgs', trigger: 'messages.sent', channelIds: [CHANNEL] })]),
      ).toEqual([]);

      const level = check([
        withRequirement({ id: 'lvl', trigger: 'leveling.level', channelIds: [CHANNEL] }),
      ]);
      expect(paths(level)).toEqual(['achievements.0.requirements.0.channelIds']);
      expect(level[0]?.message).toBe('“Reach a level” can’t be limited to channels.');

      const days = check([
        withRequirement({ id: 'days', trigger: 'membership.days', excludedChannelIds: [CHANNEL] }),
      ]);
      expect(paths(days)).toEqual(['achievements.0.requirements.0.excludedChannelIds']);
    });

    test('XP sources only on activity XP, each once', () => {
      expect(
        check([
          withRequirement({ id: 'xp', trigger: 'leveling.activity_xp', xpSources: ['message'] }),
        ]),
      ).toEqual([]);

      const messages = check([
        withRequirement({ id: 'msgs', trigger: 'messages.sent', xpSources: ['message'] }),
      ]);
      expect(paths(messages)).toEqual(['achievements.0.requirements.0.xpSources']);
      expect(messages[0]?.message).toBe('Only “Earn XP from activity” can choose XP sources.');

      const twice = check([
        withRequirement({
          id: 'xp',
          trigger: 'leveling.activity_xp',
          xpSources: ['voice', 'voice'],
        }),
      ]);
      expect(paths(twice)).toEqual(['achievements.0.requirements.0.xpSources']);
    });

    test('achievement pointers only on “Earn a specific achievement”', () => {
      const issues = check([
        withRequirement({
          id: 'msgs',
          trigger: 'messages.sent',
          achievementId: 'other',
          tierId: 'gold',
        }),
      ]);
      expect(paths(issues)).toEqual([
        'achievements.0.requirements.0.achievementId',
        'achievements.0.requirements.0.tierId',
      ]);
    });
  });

  describe('7. prerequisites', () => {
    test('the pointer needs an achievement', () => {
      const bare = single('needy', {
        requirements: [{ id: 'held', trigger: 'achievements.unlocked' }],
        tiers: [{ id: 'single', targets: { held: 1 } }],
      });
      expect(paths(check([bare]))).toEqual(['achievements.0.requirements.0.achievementId']);
    });

    test('an achievement can’t require itself', () => {
      const issues = check([pointer('selfish', 'selfish')]);
      expect(paths(issues)).toEqual(['achievements.0.requirements.0.achievementId']);
      expect(issues[0]?.message).toBe('An achievement can’t require itself.');
    });

    test('the achievement it points at must exist', () => {
      expect(paths(check([pointer('needy', 'missing')]))).toEqual([
        'achievements.0.requirements.0.achievementId',
      ]);
    });

    test('the chosen tier must exist on it', () => {
      expect(check([pointer('needy', 'regular', 'silver'), tiered('regular')])).toEqual([]);
      expect(check([pointer('needy', 'chatterbox', 'single'), single('chatterbox')])).toEqual([]);

      const gold = check([pointer('needy', 'regular', 'gold'), tiered('regular')]);
      expect(paths(gold)).toEqual(['achievements.0.requirements.0.tierId']);
      expect(gold[0]?.message).toBe('“Regular” has no Gold tier.');

      const singleGold = check([pointer('needy', 'chatterbox', 'gold'), single('chatterbox')]);
      expect(singleGold[0]?.message).toBe(
        '“Chatterbox” is a single achievement, so it has no Gold tier.',
      );

      const tieredSingle = check([pointer('needy', 'regular', 'single'), tiered('regular')]);
      expect(tieredSingle[0]?.message).toBe('“Regular” is tiered, so pick one of its tiers.');
    });

    test('a loop is refused and named', () => {
      const issues = check([pointer('alpha', 'bravo'), pointer('bravo', 'alpha')]);
      expect(paths(issues)).toEqual(['achievements.1.requirements.0.achievementId']);
      expect(issues[0]?.message).toBe(
        'These achievements depend on each other in a loop: Alpha → Bravo → Alpha.',
      );
    });

    test('a longer loop is found once', () => {
      const issues = check([
        pointer('alpha', 'bravo'),
        pointer('bravo', 'charlie'),
        pointer('charlie', 'alpha'),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toBe(
        'These achievements depend on each other in a loop: Alpha → Bravo → Charlie → Alpha.',
      );
    });

    test('shared prerequisites are not a loop', () => {
      expect(
        check([pointer('alpha', 'charlie'), pointer('bravo', 'charlie'), single('charlie')]),
      ).toEqual([]);
    });
  });

  describe('8. dates', () => {
    test('the deadline comes after the start', () => {
      const backwards = single('dated', {
        startsAt: '2026-10-02T00:00:00.000Z',
        endsAt: '2026-10-01T00:00:00.000Z',
      });
      const issues = check([backwards]);
      expect(paths(issues)).toEqual(['achievements.0.endsAt']);
      expect(issues[0]?.message).toBe('The deadline must be after the start.');
    });

    test('a new or changed deadline can’t be in the past', () => {
      const past = single('dated', { endsAt: '2026-09-01T00:00:00.000Z' });
      expect(paths(check([past]))).toEqual(['achievements.0.endsAt']);

      const moved = single('dated', { endsAt: '2026-09-02T00:00:00.000Z' });
      expect(paths(check([moved], { before: [past] }))).toEqual(['achievements.0.endsAt']);
    });

    test('an unchanged past deadline doesn’t block saving', () => {
      const past = single('dated', { endsAt: '2026-09-01T00:00:00.000Z' });
      expect(check([past], { before: [past] })).toEqual([]);

      const sameInstant = single('dated', { endsAt: '2026-09-01T01:00:00.000+01:00' });
      expect(check([sameInstant], { before: [past] })).toEqual([]);
    });
  });

  describe('9. announcements', () => {
    test('a custom announcement needs a destination and a message', () => {
      const custom = single('loud', { announcement: { mode: 'custom' } });
      expect(paths(check([custom]))).toEqual([
        'achievements.0.announcement.destination',
        'achievements.0.announcement.message',
      ]);

      const channel = single('loud', {
        announcement: { mode: 'custom', destination: 'channel', message: { content: 'Hi' } },
      });
      expect(paths(check([channel]))).toEqual(['achievements.0.announcement.channelId']);

      const done = single('loud', {
        announcement: {
          mode: 'custom',
          destination: 'channel',
          channelId: CHANNEL,
          message: { content: 'Hi' },
        },
      });
      expect(check([done])).toEqual([]);
    });

    test('module destinations that name a channel need one', () => {
      const issues = check([], {
        module: {
          announcement: { destination: 'channel', fallback: 'channel' },
          almostThere: { destination: 'channel' },
        },
      });
      expect(paths(issues)).toEqual([
        'announcement.channelId',
        'announcement.fallbackChannelId',
        'almostThere.channelId',
      ]);
    });
  });

  describe('10. requirement versions', () => {
    const stored = single('chatterbox', {
      requirements: [{ id: 'msgs', trigger: 'messages.sent', version: 2 }],
    });

    test('changing what counts without a new version is refused', () => {
      const edited = single('chatterbox', {
        requirements: [{ id: 'msgs', trigger: 'messages.sent', version: 2, channelIds: [CHANNEL] }],
      });
      const issues = check([edited], { before: [stored] });
      expect(paths(issues)).toEqual(['achievements.0.requirements.0.version']);
      expect(issues[0]?.message).toBe(VERSION_CHANGED);
    });

    test('changing what counts with a new version is accepted', () => {
      const edited = single('chatterbox', {
        requirements: [{ id: 'msgs', trigger: 'messages.sent', version: 3, channelIds: [CHANNEL] }],
      });
      expect(check([edited], { before: [stored] })).toEqual([]);
    });

    test('a version never goes down', () => {
      const lowered = single('chatterbox', {
        requirements: [{ id: 'msgs', trigger: 'messages.sent', version: 1 }],
      });
      expect(paths(check([lowered], { before: [stored] }))).toEqual([
        'achievements.0.requirements.0.version',
      ]);
    });

    test('targets, rewards and channel order change nothing that counts', () => {
      const before = single('chatterbox', {
        requirements: [
          { id: 'msgs', trigger: 'messages.sent', channelIds: [CHANNEL, '300000000000000002'] },
        ],
      });
      const after = single('chatterbox', {
        requirements: [
          { id: 'msgs', trigger: 'messages.sent', channelIds: ['300000000000000002', CHANNEL] },
        ],
        tiers: [{ id: 'single', targets: { msgs: 99 }, rewards: [{ kind: 'xp', amount: 10 }] }],
      });
      expect(check([after], { before: [before] })).toEqual([]);
    });

    test('a trigger swap needs a bump too', () => {
      const swapped = single('chatterbox', {
        requirements: [{ id: 'msgs', trigger: 'reactions.given', version: 2 }],
      });
      expect(paths(check([swapped], { before: [stored] }))).toEqual([
        'achievements.0.requirements.0.version',
      ]);
    });

    test('a new requirement id starts wherever it likes', () => {
      const added = single('chatterbox', {
        requirements: [
          { id: 'msgs', trigger: 'messages.sent', version: 2 },
          { id: 'voice', trigger: 'voice.minutes' },
        ],
        tiers: [{ id: 'single', targets: { msgs: 10, voice: 10 } }],
      });
      expect(check([added], { before: [stored] })).toEqual([]);
    });
  });

  describe('11. lifecycle', () => {
    test('an archived achievement can’t go back to draft', () => {
      const archived = single('retired', { status: 'archived' });

      const issues = check([single('retired', { status: 'draft' })], { before: [archived] });
      expect(paths(issues)).toEqual(['achievements.0.status']);

      expect(check([single('retired', { status: 'paused' })], { before: [archived] })).toEqual([]);
      expect(check([single('retired', { status: 'active' })], { before: [archived] })).toEqual([]);
    });
  });
});
