import { describe, expect, test } from 'bun:test';
import type { ModuleIndex } from '@proton/core';
import {
  type Achievement,
  type AchievementsConfig,
  achievementSchema,
  achievementsConfigSchema,
} from '@proton/module-achievements/config';
import { PRESET_IDS } from '@proton/module-achievements/presets';
import { VERSION_CHANGED, validateConfig } from '@proton/module-achievements/validate';
import type { GuildRole } from '../src/lib/discord.ts';
import {
  bumpVersions,
  changedRoleRewards,
  configIssues,
  createFromPreset,
  dependencyNote,
  duplicateAchievement,
  duplicateAsNewVersion,
  issueIndexes,
  issueSaveNote,
  issuesAt,
  NO_CHANGES,
  newAchievement,
  offDependencies,
  presetDependencyStates,
  rewardRoleIssues,
  rewardSaveNote,
  savedAchievement,
  savedConfig,
  semanticDiff,
  uniqueAchievementId,
  xpRewardNote,
} from '../src/pages/achievements/shape.ts';

const GUILD = '100000000000000001';
const REGULAR = '100000000000000011';
const STAFF = '100000000000000012';
const BOOSTER = '100000000000000013';
const GONE = '100000000000000014';
const VIP = '100000000000000015';
const NOW = Date.parse('2026-09-19T12:00:00Z');

function seeded(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function role(id: string, name: string, position: number, extra: Partial<GuildRole> = {}) {
  return {
    id,
    name,
    position,
    color: 0,
    managed: false,
    premiumSubscriber: false,
    assignable: true,
    ...extra,
  } satisfies GuildRole;
}

const ROLES: GuildRole[] = [
  role(STAFF, 'Staff', 9, { assignable: false }),
  role(VIP, 'VIP', 6),
  role(REGULAR, 'Regular', 3),
  role(BOOSTER, 'Server Booster', 2, { managed: true, premiumSubscriber: true }),
];

function chatterbox(overrides: Partial<Achievement> = {}): Achievement {
  return achievementSchema.parse({
    id: 'chatterbox',
    name: 'Chatterbox',
    status: 'active',
    kind: 'tiered',
    requirements: [{ id: 'msgs', trigger: 'messages.sent' }],
    tiers: [
      { id: 'bronze', targets: { msgs: 50 } },
      { id: 'silver', targets: { msgs: 250 } },
      { id: 'gold', targets: { msgs: 1000 }, rewards: [{ kind: 'add_role', roleId: REGULAR }] },
    ],
    ...overrides,
  });
}

function config(...achievements: Achievement[]): AchievementsConfig {
  return achievementsConfigSchema.parse({ achievements });
}

function edit(achievement: Achievement, change: (draft: Achievement) => void): Achievement {
  const draft = structuredClone(achievement);
  change(draft);
  return draft;
}

function index(enabled: Record<string, boolean>): ModuleIndex {
  return {
    modules: Object.entries(enabled).map(([id, on]) => ({
      id,
      name: id,
      category: 'engagement',
      fields: [],
      commands: [],
      enabled: on,
      dashboard: null,
      status: null,
    })),
  };
}

describe('the saved copy', () => {
  test('is the stored config parsed, or nothing to compare against when it does not parse', () => {
    const stored = config(chatterbox());

    expect(savedConfig(stored)).toEqual(stored);
    expect(savedAchievement(savedConfig(stored), 'chatterbox')?.name).toBe('Chatterbox');
    expect(savedConfig({ timezone: 'Nowhere/Nope' })).toBeNull();
    expect(savedAchievement(null, 'chatterbox')).toBeUndefined();
  });
});

describe('semanticDiff', () => {
  const saved = chatterbox();

  test('a new achievement has nothing to compare against', () => {
    expect(semanticDiff(undefined, saved)).toEqual(NO_CHANGES);
  });

  test('name, description, badge and announcement are cosmetic', () => {
    const draft = edit(saved, (a) => {
      a.name = 'Chatty';
      a.description = 'Talk a lot.';
      a.badge = { shape: 'hexagon', icon: 'chat', colour: 0x123456 };
      a.announcement = { mode: 'off' };
    });

    expect(semanticDiff(saved, draft)).toEqual(NO_CHANGES);
  });

  test('a changed target is a target change only', () => {
    const draft = edit(saved, (a) => {
      if (a.tiers[1]) a.tiers[1].targets.msgs = 300;
    });

    expect(semanticDiff(saved, draft)).toEqual({ ...NO_CHANGES, targets: true });
  });

  test('a changed trigger or channel filter changes what counts', () => {
    const trigger = edit(saved, (a) => {
      if (a.requirements[0]) a.requirements[0].trigger = 'reactions.given';
    });
    const channels = edit(saved, (a) => {
      if (a.requirements[0]) a.requirements[0].channelIds = [GONE];
    });
    const both = edit(saved, (a) => {
      if (a.requirements[0]) a.requirements[0].channelIds = [GONE, VIP];
    });
    const reordered = edit(saved, (a) => {
      if (a.requirements[0]) a.requirements[0].channelIds = [VIP, GONE];
    });

    expect(semanticDiff(saved, trigger).requirements).toBe(true);
    expect(semanticDiff(saved, channels).requirements).toBe(true);
    expect(semanticDiff(both, reordered)).toEqual(NO_CHANGES);
  });

  test('a changed reward is a reward change only', () => {
    const draft = edit(saved, (a) => {
      if (a.tiers[2]) a.tiers[2].rewards = [{ kind: 'xp', amount: 250 }];
    });

    expect(semanticDiff(saved, draft)).toEqual({ ...NO_CHANGES, rewards: true });
  });

  test('dates compare as instants, so the same moment written another way is no change', () => {
    const dated = chatterbox({ endsAt: '2026-10-14T18:00:00+01:00' });

    expect(semanticDiff(dated, chatterbox({ endsAt: '2026-10-14T17:00:00Z' })).dates).toBe(false);
    expect(semanticDiff(dated, chatterbox({ endsAt: '2026-10-15T17:00:00Z' })).dates).toBe(true);
    expect(semanticDiff(saved, chatterbox({ includeRecorded: true })).dates).toBe(true);
  });

  test('switching kind or removing a tier is structural; adding a tier moves the targets', () => {
    const removed = edit(saved, (a) => {
      a.tiers = a.tiers.slice(0, 2);
    });
    const added = edit(saved, (a) => {
      a.tiers.push({ id: 'diamond', targets: { msgs: 5000 }, rewards: [] });
    });
    const single = edit(saved, (a) => {
      a.kind = 'single';
      a.tiers = [{ id: 'single', targets: { msgs: 50 }, rewards: [] }];
    });

    expect(semanticDiff(saved, removed).structure).toBe(true);
    expect(semanticDiff(saved, added)).toEqual({ ...NO_CHANGES, targets: true });
    expect(semanticDiff(saved, single).structure).toBe(true);
  });
});

describe('bumpVersions', () => {
  const saved = config(chatterbox());
  const retriggered = config(
    edit(chatterbox(), (a) => {
      if (a.requirements[0]) a.requirements[0].trigger = 'reactions.given';
    }),
  );

  test('bumps a requirement whose trigger or filters changed, which the write check then accepts', () => {
    const bumped = bumpVersions(saved, retriggered);

    expect(bumped.achievements[0]?.requirements[0]?.version).toBe(2);
    expect(validateConfig(bumped, saved, NOW)).toEqual([]);
  });

  test('without the bump the api refuses the save', () => {
    expect(validateConfig(retriggered, saved, NOW)).toContainEqual({
      path: 'achievements.0.requirements.0.version',
      message: VERSION_CHANGED,
    });
  });

  test('is idempotent, and a change reverted puts the saved version back', () => {
    const once = bumpVersions(saved, retriggered);
    expect(bumpVersions(saved, once)).toBe(once);

    const reverted = config(chatterbox());
    const reverted2 = edit(reverted.achievements[0] as Achievement, (a) => {
      if (a.requirements[0]) a.requirements[0].version = 2;
    });

    expect(bumpVersions(saved, config(reverted2)).achievements[0]?.requirements[0]?.version).toBe(
      1,
    );
  });

  test('leaves the draft object alone when nothing that counts changed', () => {
    const targets = config(
      edit(chatterbox(), (a) => {
        if (a.tiers[0]) a.tiers[0].targets.msgs = 60;
      }),
    );

    expect(bumpVersions(saved, targets)).toBe(targets);
    expect(bumpVersions(saved, saved)).toBe(saved);
  });

  test('bumps from the saved version, never from a stale draft', () => {
    const storedAtThree = config(
      edit(chatterbox(), (a) => {
        if (a.requirements[0]) a.requirements[0].version = 3;
      }),
    );

    expect(bumpVersions(storedAtThree, retriggered).achievements[0]?.requirements[0]?.version).toBe(
      4,
    );
  });

  test('new requirements and new achievements keep their own version', () => {
    const fresh = newAchievement('single', ['chatterbox'], seeded());
    const next = config(chatterbox(), fresh);

    expect(bumpVersions(saved, next)).toBe(next);
  });
});

describe('live config issues', () => {
  const dependent = achievementSchema.parse({
    id: 'all-rounder',
    name: 'All-Rounder',
    kind: 'single',
    requirements: [{ id: 'pre', trigger: 'achievements.unlocked', achievementId: 'chatterbox' }],
    tiers: [{ id: 'single', targets: { pre: 1 } }],
  });

  test('are the rules the api saves against, run on what the save would send', () => {
    const saved = config(chatterbox(), dependent);
    const deleted = config(dependent);

    expect(configIssues(saved, saved, NOW)).toEqual([]);
    expect(configIssues(null, deleted, NOW)).toEqual([]);
    expect(configIssues(saved, deleted, NOW)).toEqual([
      {
        path: 'achievements.0.requirements.0.achievementId',
        message: 'That achievement doesn’t exist any more. Pick another one.',
      },
    ]);
  });

  test('a requirement edited without its version bump is not reported as one', () => {
    const saved = config(chatterbox());
    const retriggered = config(
      edit(chatterbox(), (a) => {
        if (a.requirements[0]) a.requirements[0].trigger = 'reactions.given';
      }),
    );

    expect(validateConfig(retriggered, saved, NOW)).not.toEqual([]);
    expect(configIssues(saved, retriggered, NOW)).toEqual([]);
  });

  test('are named by achievement, indexed for the list and counted in the note', () => {
    const issues = configIssues(config(chatterbox(), dependent), config(dependent), NOW);

    expect(issueIndexes(issues)).toEqual(new Set([0]));
    expect(issuesAt(issues, 0).get('achievements.0.requirements.0.achievementId')).toBe(
      'That achievement doesn’t exist any more. Pick another one.',
    );
    expect(issuesAt(issues, 1).size).toBe(0);
    expect(issueSaveNote(config(dependent), issues)).toBe(
      'All-Rounder: That achievement doesn’t exist any more. Pick another one.',
    );
    expect(issueSaveNote(config(dependent), [])).toBeUndefined();
    expect(
      issueSaveNote(config(dependent), [
        ...issues,
        { path: 'announcement.channelId', message: 'Pick one.' },
      ]),
    ).toBe(
      '2 settings need fixing before saving. All-Rounder: That achievement doesn’t exist any more. Pick another one.',
    );
  });
});

describe('creating achievements', () => {
  test.each(['single', 'tiered'] as const)('a new %s achievement is a valid draft', (kind) => {
    const made = newAchievement(kind, [], seeded());

    expect(made.status).toBe('draft');
    expect(achievementSchema.safeParse(made).success).toBe(true);
    expect(validateConfig(config(made), config(), NOW)).toEqual([]);
  });

  test.each([...PRESET_IDS])(
    'preset %s instantiates to a draft the config and write check accept',
    (presetId) => {
      const made = createFromPreset(presetId, { taken: [], random: seeded(), roleId: REGULAR });

      expect(made.status).toBe('draft');
      expect(achievementSchema.safeParse(made).success).toBe(true);
      expect(validateConfig(config(made), config(), NOW)).toEqual([]);
    },
  );

  test('All-Rounder gives the chosen role and 250 XP, and cannot be made without a role', () => {
    const made = createFromPreset('all_rounder', { taken: [], random: seeded(), roleId: VIP });

    expect(made.requirements.map((r) => r.trigger)).toEqual([
      'messages.sent',
      'voice.minutes',
      'leveling.level',
    ]);
    expect(made.tiers[0]?.rewards).toEqual([
      { kind: 'add_role', roleId: VIP },
      { kind: 'xp', amount: 250 },
    ]);
    expect(() => createFromPreset('all_rounder', { taken: [], random: seeded() })).toThrow(
      /pick the role/,
    );
  });

  test('a preset never reuses an id already taken', () => {
    const first = createFromPreset('voice_regular', { taken: [], random: seeded(3) });
    const second = createFromPreset('voice_regular', { taken: [first.id], random: seeded(3) });

    expect(second.id).not.toBe(first.id);
  });

  test('an id is still found when the random source keeps repeating itself', () => {
    const stuck = () => 0.5;
    const taken = [uniqueAchievementId([], stuck)];

    const next = uniqueAchievementId(taken, stuck);
    expect(next).not.toBe(taken[0]);
    expect(achievementSchema.shape.id.safeParse(next).success).toBe(true);
  });

  test('a preset lists the modules it needs and whether each is on', () => {
    expect(presetDependencyStates('all_rounder', index({ leveling: false }))).toEqual([
      { module: 'leveling', label: 'Leveling', enabled: false },
    ]);
    expect(presetDependencyStates('conversation_starter', index({}))).toEqual([]);
    expect(presetDependencyStates('rising_star', undefined)).toEqual([]);
  });
});

describe('duplicating', () => {
  const source = chatterbox({
    requirements: [
      { id: 'msgs', version: 4, trigger: 'messages.sent', channelIds: [], excludedChannelIds: [] },
    ],
    endsAt: '2026-01-01T00:00:00Z',
    startsAt: '2025-12-01T00:00:00Z',
  });

  test('a duplicate is a fresh draft with a new id, its own name and progress from nothing', () => {
    const copy = duplicateAchievement(source, [source.id], seeded(), NOW);

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('Chatterbox (copy)');
    expect(copy.status).toBe('draft');
    expect(copy.requirements[0]?.version).toBe(1);
    expect(copy.tiers).toEqual(source.tiers);
    expect(copy.endsAt).toBeUndefined();
    expect(copy.startsAt).toBe('2025-12-01T00:00:00Z');
    expect(validateConfig(config(source, copy), config(source), NOW)).toEqual([]);
  });

  test('a future deadline is kept', () => {
    const later = chatterbox({ endsAt: '2027-01-01T00:00:00Z' });
    expect(duplicateAchievement(later, [later.id], seeded(), NOW).endsAt).toBe(
      '2027-01-01T00:00:00Z',
    );
  });

  test('the name stays within the limit', () => {
    const long = chatterbox({ name: 'x'.repeat(80) });
    expect(duplicateAchievement(long, [], seeded(), NOW).name.length).toBeLessThanOrEqual(80);
  });

  test('a new version copies the achievement and archives the original', () => {
    const { copy, archived } = duplicateAsNewVersion(source, [source.id], seeded(), NOW);

    expect(copy.name).toBe(source.name);
    expect(copy.status).toBe('draft');
    expect(copy.id).not.toBe(source.id);
    expect(archived).toEqual({ ...source, status: 'archived' });
    expect(validateConfig(config(archived, copy), config(source), NOW)).toEqual([]);
  });
});

describe('dependencies', () => {
  test('names the modules an achievement needs that are off', () => {
    const rising = createFromPreset('rising_star', { taken: [], random: seeded() });
    const off = offDependencies(rising, index({ leveling: false, starboard: true }));

    expect(off).toEqual([{ module: 'leveling', label: 'Leveling', enabled: false }]);
    expect(dependencyNote(off)).toBe('Needs Leveling, which is off.');
    expect(offDependencies(rising, index({ leveling: true }))).toEqual([]);
    expect(offDependencies(rising, undefined)).toEqual([]);
  });

  test('a module missing from the index counts as off', () => {
    const star = createFromPreset('star_contributor', { taken: [], random: seeded() });
    expect(dependencyNote(offDependencies(star, index({})))).toBe('Needs Starboard, which is off.');
  });

  test('several off modules are listed together', () => {
    expect(
      dependencyNote([
        { module: 'leveling', label: 'Leveling', enabled: false },
        { module: 'starboard', label: 'Starboard', enabled: false },
      ]),
    ).toBe('Needs Leveling and Starboard, which are off.');
  });

  test('an XP reward with Leveling off gets a note, not a block', () => {
    const xp = chatterbox({
      tiers: [
        { id: 'bronze', targets: { msgs: 50 }, rewards: [{ kind: 'xp', amount: 100 }] },
        { id: 'silver', targets: { msgs: 250 }, rewards: [] },
      ],
    });

    expect(xpRewardNote(xp, index({ leveling: false }))).toContain('Leveling is off');
    expect(xpRewardNote(xp, index({ leveling: true }))).toBeNull();
    expect(xpRewardNote(chatterbox(), index({ leveling: false }))).toBeNull();
  });
});

describe('reward roles', () => {
  const saved = config(chatterbox());
  const power = { manageRoles: true, highestPosition: 5 };

  function withGoldRewards(...roleIds: string[]): AchievementsConfig {
    const draft = edit(chatterbox(), (a) => {
      if (a.tiers[2]) {
        a.tiers[2].rewards = [
          { kind: 'add_role', roleId: REGULAR },
          ...roleIds.map((roleId) => ({ kind: 'add_role' as const, roleId })),
        ];
      }
    });

    return { ...saved, achievements: [draft] };
  }

  test('only rewards changed since the last save are checked', () => {
    const draft = withGoldRewards(VIP);

    expect(changedRoleRewards(saved, draft).map((item) => item.reward.roleId)).toEqual([VIP]);
    expect(changedRoleRewards(saved, saved)).toEqual([]);
  });

  test('each problem is named, with where to fix it', () => {
    const draft = withGoldRewards(GUILD, GONE, BOOSTER, STAFF, VIP);
    const issues = rewardRoleIssues(saved, draft, { guildId: GUILD, roles: ROLES, power });

    expect(issues.map((issue) => [issue.roleId, issue.problem])).toEqual([
      [GUILD, 'everyone'],
      [GONE, 'missing'],
      [BOOSTER, 'managed'],
      [STAFF, 'above_proton'],
      [VIP, 'above_proton'],
    ]);
    expect(issues[0]?.path).toBe('achievements.0.tiers.2.rewards.1.roleId');
    expect(issues[3]?.message).toContain('@Staff is at or above Proton’s highest role');
    expect(issues[3]?.message).toContain('Server Settings → Roles');
  });

  test('Proton without Manage Roles blocks every changed role reward, naming the permission', () => {
    const draft = withGoldRewards(VIP);
    const [issue] = rewardRoleIssues(saved, draft, {
      guildId: GUILD,
      roles: ROLES,
      power: { manageRoles: false, highestPosition: 10 },
    });

    expect(issue?.problem).toBe('no_manage_roles');
    expect(issue?.message).toContain('Manage Roles');
  });

  test('a removal reward is checked the same way and says “remove”', () => {
    const draft = config(
      edit(chatterbox(), (a) => {
        if (a.tiers[0]) a.tiers[0].rewards = [{ kind: 'remove_role', roleId: BOOSTER }];
      }),
    );
    const [issue] = rewardRoleIssues(saved, draft, { guildId: GUILD, roles: ROLES, power });

    expect(issue?.kind).toBe('remove_role');
    expect(issue?.message).toBe(
      '@Server Booster is managed by Discord or an integration, so Proton can’t remove it.',
    );
  });

  test('with Proton’s roles unknown, the picker’s own reading decides and nothing is guessed', () => {
    const draft = withGoldRewards(STAFF, VIP);

    expect(
      rewardRoleIssues(saved, draft, { guildId: GUILD, roles: ROLES, power: null }).map(
        (issue) => issue.roleId,
      ),
    ).toEqual([STAFF]);
    expect(
      rewardRoleIssues(saved, withGoldRewards(GONE), {
        guildId: GUILD,
        roles: undefined,
        power: undefined,
      }),
    ).toEqual([]);
  });

  test('the save note names the achievement and tier', () => {
    const one = rewardRoleIssues(saved, withGoldRewards(STAFF), {
      guildId: GUILD,
      roles: ROLES,
      power,
    });
    const many = rewardRoleIssues(saved, withGoldRewards(STAFF, BOOSTER), {
      guildId: GUILD,
      roles: ROLES,
      power,
    });

    expect(rewardSaveNote([])).toBeUndefined();
    expect(rewardSaveNote(one)).toStartWith('Chatterbox (Gold): @Staff is at or above');
    expect(rewardSaveNote(many)).toStartWith(
      '2 reward roles can’t be used, in Chatterbox. Fix them before saving.',
    );
  });
});
