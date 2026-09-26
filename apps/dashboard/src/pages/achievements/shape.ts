import { TIER_LABELS } from '@proton/cards/design';
import type { ConfigWriteIssue, ModuleIndex, TierId } from '@proton/core';
import {
  type Achievement,
  type AchievementKind,
  type AchievementsConfig,
  achievementsConfigSchema,
  type Requirement,
  type Reward,
  TIERED_IDS,
} from '@proton/module-achievements/config';
import {
  dependenciesOf,
  joinAnd,
  newAchievementId,
  newRequirementId,
  revisionOf,
  rewardKeyOf,
} from '@proton/module-achievements/evaluate';
import {
  instantiatePreset,
  type PresetId,
  presetDependencies,
} from '@proton/module-achievements/presets';
import {
  DEPENDENCY_LABELS,
  DEPENDENCY_MODULES,
  type DependencyModule,
  isTriggerId,
  REWARD_KINDS,
} from '@proton/module-achievements/triggers';
import { validateConfig } from '@proton/module-achievements/validate';
import type { GuildRole, ProtonRolePower } from '../../lib/discord.ts';

type Random = () => number;

interface WithAchievements {
  achievements: readonly Achievement[];
}

export const NEW_ACHIEVEMENT_NAME = 'New achievement';

const NEW_SINGLE_TARGET = 100;
const NEW_TIERED_TARGETS = [100, 500, 1000] as const;
const NAME_MAX = 80;
const ID_ATTEMPTS = 8;

export function savedConfig(stored: unknown): AchievementsConfig | null {
  const parsed = achievementsConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export function savedAchievement(
  saved: AchievementsConfig | null,
  id: string,
): Achievement | undefined {
  return saved?.achievements.find((achievement) => achievement.id === id);
}

function firstById(achievements: readonly Achievement[]): Map<string, Achievement> {
  const byId = new Map<string, Achievement>();
  for (const achievement of achievements) {
    if (!byId.has(achievement.id)) byId.set(achievement.id, achievement);
  }
  return byId;
}

export function uniqueAchievementId(taken: Iterable<string>, random: Random = Math.random): string {
  const used = new Set(taken);
  let drawn = newAchievementId(random);

  for (let attempt = 1; used.has(drawn); attempt++) {
    drawn = attempt < ID_ATTEMPTS ? newAchievementId(random) : `${drawn.slice(0, 24)}-${attempt}`;
  }

  return drawn;
}

export function newAchievement(
  kind: AchievementKind,
  taken: Iterable<string> = [],
  random: Random = Math.random,
): Achievement {
  const requirementId = newRequirementId(random);

  return {
    id: uniqueAchievementId(taken, random),
    name: NEW_ACHIEVEMENT_NAME,
    description: '',
    status: 'draft',
    badge: { shape: 'circle', icon: 'trophy', colour: 'tier' },
    kind,
    requirements: [
      {
        id: requirementId,
        version: 1,
        trigger: 'messages.sent',
        channelIds: [],
        excludedChannelIds: [],
      },
    ],
    tiers:
      kind === 'single'
        ? [{ id: 'single', targets: { [requirementId]: NEW_SINGLE_TARGET }, rewards: [] }]
        : NEW_TIERED_TARGETS.map((target, index) => ({
            id: TIERED_IDS[index] ?? 'bronze',
            targets: { [requirementId]: target },
            rewards: [],
          })),
    roleIds: [],
    excludedRoleIds: [],
    includeRecorded: false,
    almostThere: { enabled: false, percent: 80 },
    announcement: { mode: 'default' },
  };
}

function copyName(name: string): string {
  const suffix = ' (copy)';
  return `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

function freshCopy(source: Achievement, id: string, now: number): Achievement {
  const copy = structuredClone(source);
  const endsAt = copy.endsAt === undefined ? Number.NaN : Date.parse(copy.endsAt);

  // A deadline already past is refused on any achievement that did not have it before.
  if (endsAt < now) delete copy.endsAt;

  return {
    ...copy,
    id,
    status: 'draft',
    requirements: copy.requirements.map((requirement) => ({ ...requirement, version: 1 })),
  };
}

export function duplicateAchievement(
  source: Achievement,
  taken: Iterable<string>,
  random: Random = Math.random,
  now: number = Date.now(),
): Achievement {
  const copy = freshCopy(source, uniqueAchievementId(taken, random), now);
  return { ...copy, name: copyName(source.name) };
}

export function duplicateAsNewVersion(
  source: Achievement,
  taken: Iterable<string>,
  random: Random = Math.random,
  now: number = Date.now(),
): { copy: Achievement; archived: Achievement } {
  return {
    copy: freshCopy(source, uniqueAchievementId(taken, random), now),
    archived: { ...source, status: 'archived' },
  };
}

export function createFromPreset(
  presetId: PresetId,
  options: { taken: Iterable<string>; random?: Random; roleId?: string | undefined },
): Achievement {
  const random = options.random ?? Math.random;
  const taken = new Set(options.taken);
  const made = instantiatePreset(presetId, {
    random,
    ...(options.roleId === undefined ? {} : { roleId: options.roleId }),
  });

  return taken.has(made.id) ? { ...made, id: uniqueAchievementId(taken, random) } : made;
}

function sameRequirement(a: Requirement, b: Requirement): boolean {
  if (isTriggerId(a.trigger) && isTriggerId(b.trigger)) return revisionOf(a) === revisionOf(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

function instantOf(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function rewardSignature(reward: Reward): string {
  return reward.kind === 'xp' ? `xp:${reward.amount}` : rewardKeyOf(reward);
}

function sameRewards(a: readonly Reward[], b: readonly Reward[]): boolean {
  const left = a.map(rewardSignature).sort();
  const right = b.map(rewardSignature).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export interface SemanticDiff {
  targets: boolean;
  requirements: boolean;
  rewards: boolean;
  dates: boolean;
  structure: boolean;
}

export const NO_CHANGES: SemanticDiff = {
  targets: false,
  requirements: false,
  rewards: false,
  dates: false,
  structure: false,
};

export function semanticDiff(saved: Achievement | undefined, draft: Achievement): SemanticDiff {
  if (saved === undefined) return NO_CHANGES;

  const savedRequirements = new Map(saved.requirements.map((item) => [item.id, item]));
  const draftRequirementIds = new Set(draft.requirements.map((item) => item.id));
  const savedTiers = new Map(saved.tiers.map((tier) => [tier.id, tier]));
  const draftTierIds = new Set(draft.tiers.map((tier) => tier.id));

  const requirements = draft.requirements.some((requirement) => {
    const before = savedRequirements.get(requirement.id);
    return before === undefined || !sameRequirement(before, requirement);
  });

  const removedRequirement = saved.requirements.some((item) => !draftRequirementIds.has(item.id));
  const addedTier = draft.tiers.some((tier) => !savedTiers.has(tier.id));

  const targets =
    removedRequirement ||
    addedTier ||
    draft.tiers.some((tier) => {
      const before = savedTiers.get(tier.id);
      return (
        before !== undefined &&
        draft.requirements.some(
          (requirement) =>
            savedRequirements.has(requirement.id) &&
            before.targets[requirement.id] !== tier.targets[requirement.id],
        )
      );
    });

  const rewards = draft.tiers.some((tier) => {
    const before = savedTiers.get(tier.id);
    return before !== undefined && !sameRewards(before.rewards, tier.rewards);
  });

  const dates =
    instantOf(saved.startsAt) !== instantOf(draft.startsAt) ||
    instantOf(saved.endsAt) !== instantOf(draft.endsAt) ||
    saved.includeRecorded !== draft.includeRecorded;

  const structure = saved.kind !== draft.kind || saved.tiers.some((t) => !draftTierIds.has(t.id));

  return { targets, requirements, rewards, dates, structure };
}

export function bumpVersions<T extends WithAchievements>(saved: WithAchievements, draft: T): T {
  const stored = firstById(saved.achievements);
  let changed = false;

  const achievements = draft.achievements.map((achievement) => {
    const previous = stored.get(achievement.id);
    if (previous === undefined) return achievement;

    let touched = false;

    const requirements = achievement.requirements.map((requirement) => {
      const before = previous.requirements.find((item) => item.id === requirement.id);
      if (before === undefined) return requirement;

      const version = sameRequirement(before, requirement) ? before.version : before.version + 1;
      if (requirement.version === version) return requirement;

      touched = true;
      return { ...requirement, version };
    });

    if (!touched) return achievement;

    changed = true;
    return { ...achievement, requirements };
  });

  return changed ? { ...draft, achievements } : draft;
}

const ACHIEVEMENT_PATH = /^achievements\.(\d+)\./;

// The rules the api refuses a save with, run here on exactly what the save would send.
export function configIssues(
  saved: AchievementsConfig | null,
  draft: AchievementsConfig,
  now: number = Date.now(),
): ConfigWriteIssue[] {
  return saved === null ? [] : validateConfig(bumpVersions(saved, draft), saved, now);
}

export function issuesAt(
  issues: readonly ConfigWriteIssue[],
  index: number,
): ReadonlyMap<string, string> {
  const prefix = `achievements.${index}.`;
  const at = new Map<string, string>();

  for (const { path, message } of issues) {
    if (path.startsWith(prefix) && !at.has(path)) at.set(path, message);
  }

  return at;
}

export function issueIndexes(issues: readonly ConfigWriteIssue[]): Set<number> {
  return new Set(
    issues.flatMap(({ path }) => {
      const index = ACHIEVEMENT_PATH.exec(path)?.[1];
      return index === undefined ? [] : [Number(index)];
    }),
  );
}

export function issueSaveNote(
  draft: AchievementsConfig,
  issues: readonly ConfigWriteIssue[],
): string | undefined {
  const [first] = issues;
  if (first === undefined) return undefined;

  const index = ACHIEVEMENT_PATH.exec(first.path)?.[1];
  const name = index === undefined ? undefined : draft.achievements[Number(index)]?.name.trim();
  const place = name === undefined || name === '' ? '' : `${name}: `;

  return issues.length === 1
    ? `${place}${first.message}`
    : `${issues.length} settings need fixing before saving. ${place}${first.message}`;
}

export interface DependencyState {
  module: DependencyModule;
  label: string;
  enabled: boolean;
}

export function enabledModuleIds(index: ModuleIndex | undefined): Set<string> {
  return new Set(
    (index?.modules ?? []).filter((module) => module.enabled).map((module) => module.id),
  );
}

export function dependencyStates(
  modules: readonly DependencyModule[],
  index: ModuleIndex | undefined,
): DependencyState[] {
  if (index === undefined) return [];

  const enabled = enabledModuleIds(index);

  return DEPENDENCY_MODULES.filter((module) => modules.includes(module)).map((module) => ({
    module,
    label: DEPENDENCY_LABELS[module],
    enabled: enabled.has(module),
  }));
}

export function rewardDependencies(achievement: Achievement): DependencyModule[] {
  const kinds = new Set(achievement.tiers.flatMap((tier) => tier.rewards.map((r) => r.kind)));
  const needed = new Set(
    REWARD_KINDS.filter((kind) => kinds.has(kind.kind)).flatMap((kind) =>
      kind.dependsOn === undefined ? [] : [kind.dependsOn],
    ),
  );

  return DEPENDENCY_MODULES.filter((module) => needed.has(module));
}

export function offDependencies(
  achievement: Achievement,
  index: ModuleIndex | undefined,
): DependencyState[] {
  return dependencyStates(dependenciesOf(achievement), index).filter((state) => !state.enabled);
}

export function presetDependencyStates(
  presetId: PresetId,
  index: ModuleIndex | undefined,
): DependencyState[] {
  return dependencyStates(presetDependencies(presetId), index);
}

export function dependencyNote(states: readonly DependencyState[]): string | null {
  const off = states.filter((state) => !state.enabled);
  if (off.length === 0) return null;

  const names = joinAnd(off.map((state) => state.label));
  return off.length === 1 ? `Needs ${names}, which is off.` : `Needs ${names}, which are off.`;
}

export function xpRewardNote(
  achievement: Achievement,
  index: ModuleIndex | undefined,
): string | null {
  const leveling = dependencyStates(rewardDependencies(achievement), index).find(
    (state) => state.module === 'leveling',
  );

  if (leveling === undefined || leveling.enabled) return null;

  return 'Leveling is off, so XP rewards can’t be given. Turn Leveling on, then retry any that failed in Members.';
}

type RoleReward = Extract<Reward, { kind: 'add_role' | 'remove_role' }>;

export interface ChangedRoleReward {
  path: string;
  achievement: Achievement;
  tierId: TierId;
  reward: RoleReward;
}

export function changedRoleRewards(
  saved: WithAchievements,
  draft: WithAchievements,
): ChangedRoleReward[] {
  const stored = firstById(saved.achievements);
  const changed: ChangedRoleReward[] = [];

  draft.achievements.forEach((achievement, index) => {
    const previous = stored.get(achievement.id);

    achievement.tiers.forEach((tier, tierIndex) => {
      const before = previous?.tiers.find((candidate) => candidate.id === tier.id);
      const kept = new Set((before?.rewards ?? []).map(rewardKeyOf));

      tier.rewards.forEach((reward, rewardIndex) => {
        if (reward.kind === 'xp' || kept.has(rewardKeyOf(reward))) return;

        changed.push({
          path: `achievements.${index}.tiers.${tierIndex}.rewards.${rewardIndex}.roleId`,
          achievement,
          tierId: tier.id,
          reward,
        });
      });
    });
  });

  return changed;
}

export type RewardRoleProblem =
  | 'everyone'
  | 'missing'
  | 'managed'
  | 'no_manage_roles'
  | 'above_proton';

export interface RewardRoleIssue {
  path: string;
  achievementId: string;
  achievementName: string;
  tierId: TierId;
  kind: RoleReward['kind'];
  roleId: string;
  problem: RewardRoleProblem;
  message: string;
}

export interface RoleFacts {
  guildId: string;
  roles: readonly GuildRole[] | undefined;
  power: ProtonRolePower | null | undefined;
}

function roleProblem(roleId: string, facts: RoleFacts): RewardRoleProblem | null {
  if (roleId === facts.guildId) return 'everyone';

  const role = facts.roles?.find((candidate) => candidate.id === roleId);
  if (facts.roles !== undefined && role === undefined) return 'missing';
  if (role?.managed) return 'managed';

  const power = facts.power ?? null;
  if (power !== null && !power.manageRoles) return 'no_manage_roles';

  if (role === undefined) return null;
  if (power !== null) return role.position >= power.highestPosition ? 'above_proton' : null;

  return role.assignable ? null : 'above_proton';
}

function problemMessage(
  problem: RewardRoleProblem,
  kind: RoleReward['kind'],
  name: string,
): string {
  const verb = kind === 'add_role' ? 'give' : 'remove';

  switch (problem) {
    case 'everyone':
      return `@everyone can’t be ${kind === 'add_role' ? 'given' : 'removed'}: every member always has it.`;
    case 'missing':
      return `${name} no longer exists in this server.`;
    case 'managed':
      return `${name} is managed by Discord or an integration, so Proton can’t ${verb} it.`;
    case 'no_manage_roles':
      return (
        `Proton doesn’t have Manage Roles in this server, so it can’t ${verb} ${name}. Give ` +
        'Proton’s role Manage Roles in Server Settings → Roles.'
      );
    case 'above_proton':
      return (
        `${name} is at or above Proton’s highest role, and Discord only lets Proton ${verb} ` +
        'roles below its own. Drag Proton’s role above it in Server Settings → Roles.'
      );
  }
}

export function rewardRoleIssues(
  saved: WithAchievements,
  draft: WithAchievements,
  facts: RoleFacts,
): RewardRoleIssue[] {
  return changedRoleRewards(saved, draft).flatMap(({ path, achievement, tierId, reward }) => {
    const problem = roleProblem(reward.roleId, facts);
    if (problem === null) return [];

    const role = facts.roles?.find((candidate) => candidate.id === reward.roleId);
    const name = role === undefined ? 'This role' : `@${role.name}`;

    return [
      {
        path,
        achievementId: achievement.id,
        achievementName: achievement.name,
        tierId,
        kind: reward.kind,
        roleId: reward.roleId,
        problem,
        message: problemMessage(problem, reward.kind, name),
      },
    ];
  });
}

function issuePlace(issue: RewardRoleIssue): string {
  return issue.tierId === 'single'
    ? issue.achievementName
    : `${issue.achievementName} (${TIER_LABELS[issue.tierId]})`;
}

export function rewardSaveNote(issues: readonly RewardRoleIssue[]): string | undefined {
  const [first] = issues;
  if (first === undefined) return undefined;

  if (issues.length === 1) return `${issuePlace(first)}: ${first.message}`;

  const names = [...new Set(issues.map((issue) => issue.achievementName))];
  return (
    `${issues.length} reward roles can’t be used, in ${joinAnd(names)}. Fix them before saving. ` +
    `${issuePlace(first)}: ${first.message}`
  );
}
