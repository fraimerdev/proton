import type { BadgeIconId, BadgeShape } from '@proton/cards/design';
import type { TierId } from '@proton/core';
import { type Achievement, type Reward, TIERED_IDS } from './config.ts';
import { newAchievementId, newRequirementId } from './evaluate.ts';
import {
  DEPENDENCY_MODULES,
  type DependencyModule,
  REWARD_KINDS,
  type TriggerId,
  triggerOf,
} from './triggers.ts';

export const PRESET_IDS = [
  'conversation_starter',
  'community_regular',
  'voice_regular',
  'rising_star',
  'star_contributor',
  'server_supporter',
  'anniversary',
  'collector',
  'all_rounder',
] as const;

export type PresetId = (typeof PRESET_IDS)[number];

export const ALL_ROUNDER_XP = 250;

interface PresetRecipe {
  label: string;
  description: string;
  memberDescription: string;
  icon: BadgeIconId;
  shape: BadgeShape;
  requirements: ReadonlyArray<{ trigger: TriggerId; targets: readonly number[] }>;
  givesRole: boolean;
  xp?: number;
}

const RECIPES: Record<PresetId, PresetRecipe> = {
  conversation_starter: {
    label: 'Conversation Starter',
    description: 'Bronze to Diamond at 50, 250, 1,000 and 5,000 messages.',
    memberDescription: 'Keep the conversation going.',
    icon: 'chat',
    shape: 'circle',
    requirements: [{ trigger: 'messages.sent', targets: [50, 250, 1000, 5000] }],
    givesRole: false,
  },
  community_regular: {
    label: 'Community Regular',
    description:
      'Bronze to Diamond at 7, 30, 90 and 365 active days, in the module’s time zone. A day ' +
      'counts when the member sends a message or spends a minute in voice.',
    memberDescription:
      'Be active on many different days. A day counts when you send a message or spend a ' +
      'minute in voice.',
    icon: 'calendar',
    shape: 'circle',
    requirements: [{ trigger: 'activity.active_days', targets: [7, 30, 90, 365] }],
    givesRole: false,
  },
  voice_regular: {
    label: 'Voice Regular',
    description: 'Bronze to Diamond at 60, 300, 1,200 and 6,000 minutes in voice.',
    memberDescription: 'Spend time with the server in voice.',
    icon: 'microphone',
    shape: 'circle',
    requirements: [{ trigger: 'voice.minutes', targets: [60, 300, 1200, 6000] }],
    givesRole: false,
  },
  rising_star: {
    label: 'Rising Star',
    description:
      'Bronze to Diamond at levels 5, 10, 25 and 50. Members already at a level earn its tier ' +
      'within a few minutes of it going active.',
    memberDescription: 'Climb the levels.',
    icon: 'rocket',
    shape: 'hexagon',
    requirements: [{ trigger: 'leveling.level', targets: [5, 10, 25, 50] }],
    givesRole: false,
  },
  star_contributor: {
    label: 'Star Contributor',
    description: 'Bronze to Diamond at 1, 5, 25 and 100 messages on the starboard.',
    memberDescription: 'Post messages the server stars.',
    icon: 'star',
    shape: 'circle',
    requirements: [{ trigger: 'starboard.messages', targets: [1, 5, 25, 100] }],
    givesRole: false,
  },
  server_supporter: {
    label: 'Server Supporter',
    description:
      'Earned the first time a member starts boosting while Achievements is on. Boosts that ' +
      'started earlier don’t count.',
    memberDescription: 'Boost the server.',
    icon: 'diamond',
    shape: 'circle',
    requirements: [{ trigger: 'boosts.started', targets: [1] }],
    givesRole: false,
  },
  anniversary: {
    label: 'Anniversary',
    description:
      'Bronze to Diamond at 30, 180, 365 and 730 days in the server. Members already past a ' +
      'milestone earn it within a few minutes of it going active.',
    memberDescription: 'Stay part of the server over time.',
    icon: 'gift',
    shape: 'circle',
    requirements: [{ trigger: 'membership.days', targets: [30, 180, 365, 730] }],
    givesRole: false,
  },
  collector: {
    label: 'Collector',
    description: 'Bronze to Diamond at 3, 5, 10 and 20 other achievements held, at any tier.',
    memberDescription: 'Earn other achievements.',
    icon: 'trophy',
    shape: 'shield',
    requirements: [{ trigger: 'achievements.earned', targets: [3, 5, 10, 20] }],
    givesRole: false,
  },
  all_rounder: {
    label: 'All-Rounder',
    description:
      'One achievement for 100 messages, 60 minutes in voice and level 5, all three together. ' +
      `Gives the role you pick and ${ALL_ROUNDER_XP} XP.`,
    memberDescription: 'Chat, spend time in voice and level up.',
    icon: 'medal',
    shape: 'shield',
    requirements: [
      { trigger: 'messages.sent', targets: [100] },
      { trigger: 'voice.minutes', targets: [60] },
      { trigger: 'leveling.level', targets: [5] },
    ],
    givesRole: true,
    xp: ALL_ROUNDER_XP,
  },
};

function tierCountOf(recipe: PresetRecipe): number {
  return recipe.requirements[0]?.targets.length ?? 1;
}

function dependenciesOfRecipe(recipe: PresetRecipe): DependencyModule[] {
  const needed = new Set<DependencyModule | null>(
    recipe.requirements.map((requirement) => triggerOf(requirement.trigger).dependsOn),
  );

  if (recipe.xp !== undefined) {
    needed.add(REWARD_KINDS.find((kind) => kind.kind === 'xp')?.dependsOn ?? null);
  }

  return DEPENDENCY_MODULES.filter((module) => needed.has(module));
}

export interface PresetDefinition {
  id: PresetId;
  label: string;
  description: string;
  kind: Achievement['kind'];
  dependsOn: DependencyModule[];
  needsRole: boolean;
}

export const PRESETS: readonly PresetDefinition[] = PRESET_IDS.map((id) => {
  const recipe = RECIPES[id];

  return {
    id,
    label: recipe.label,
    description: recipe.description,
    kind: tierCountOf(recipe) > 1 ? 'tiered' : 'single',
    dependsOn: dependenciesOfRecipe(recipe),
    needsRole: recipe.givesRole,
  };
});

export function presetDependencies(id: PresetId): DependencyModule[] {
  return dependenciesOfRecipe(RECIPES[id]);
}

export function presetNeedsRole(id: PresetId): boolean {
  return RECIPES[id].givesRole;
}

export function instantiatePreset(
  id: PresetId,
  options: { random: () => number; roleId?: string },
): Achievement {
  const recipe = RECIPES[id];
  const { roleId } = options;

  if (recipe.givesRole && roleId === undefined) {
    throw new Error(`${recipe.label} gives a role, so pick the role before creating it.`);
  }

  const taken = new Set<string>();
  const planned = recipe.requirements.map((requirement, index) => {
    const drawn = newRequirementId(options.random);
    const requirementId = taken.has(drawn) ? `${drawn}-${index}` : drawn;
    taken.add(requirementId);
    return { ...requirement, id: requirementId };
  });

  const tierCount = tierCountOf(recipe);
  const tierIds: TierId[] = tierCount > 1 ? TIERED_IDS.slice(0, tierCount) : ['single'];

  const rewards: Reward[] = [
    ...(recipe.givesRole && roleId !== undefined ? [{ kind: 'add_role' as const, roleId }] : []),
    ...(recipe.xp !== undefined ? [{ kind: 'xp' as const, amount: recipe.xp }] : []),
  ];

  return {
    id: newAchievementId(options.random),
    name: recipe.label,
    description: recipe.memberDescription,
    status: 'draft',
    badge: { shape: recipe.shape, icon: recipe.icon, colour: 'tier' },
    kind: tierCount > 1 ? 'tiered' : 'single',
    requirements: planned.map((requirement) => ({
      id: requirement.id,
      version: 1,
      trigger: requirement.trigger,
      channelIds: [],
      excludedChannelIds: [],
    })),
    tiers: tierIds.map((tierId, index) => ({
      id: tierId,
      targets: Object.fromEntries(
        planned.map((requirement) => [requirement.id, requirement.targets[index] ?? 1]),
      ),
      rewards: index === tierIds.length - 1 ? rewards : [],
    })),
    roleIds: [],
    excludedRoleIds: [],
    includeRecorded: false,
    almostThere: { enabled: false, percent: 80 },
    announcement: { mode: 'default' },
  };
}
