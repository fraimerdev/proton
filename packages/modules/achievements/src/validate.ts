import { TIER_LABELS } from '@proton/cards/design';
import type { ConfigWriteIssue } from '@proton/core';
import { type Achievement, type AchievementsConfig, TIERED_IDS, type Tier } from './config.ts';
import { revisionOf, rewardKeyOf } from './evaluate.ts';
import { triggerOf } from './triggers.ts';

export const VERSION_CHANGED =
  'This requirement changed since the page loaded. Reload the page and save again.';

type Report = (path: string, message: string) => void;

const numbers = new Intl.NumberFormat('en-GB');

function quoted(text: string): string {
  return `“${text}”`;
}

function firstById(achievements: readonly Achievement[]): Map<string, Achievement> {
  const byId = new Map<string, Achievement>();
  for (const achievement of achievements) {
    if (!byId.has(achievement.id)) byId.set(achievement.id, achievement);
  }
  return byId;
}

function tierName(achievement: Achievement, tier: Tier): string {
  return achievement.kind === 'single' ? 'This achievement' : TIER_LABELS[tier.id];
}

function checkShape(achievement: Achievement, base: string, report: Report): void {
  const ids = new Set<string>();

  achievement.requirements.forEach((requirement, index) => {
    if (ids.has(requirement.id)) {
      report(
        `${base}.requirements.${index}.id`,
        'Another requirement of this achievement already uses this ID.',
      );
    }
    ids.add(requirement.id);
  });

  if (achievement.kind === 'single') {
    if (achievement.tiers.length !== 1 || achievement.tiers[0]?.id !== 'single') {
      report(`${base}.tiers`, 'A single achievement has exactly one tier, with the ID “single”.');
    }
    return;
  }

  const inOrder = achievement.tiers.every((tier, index) => tier.id === TIERED_IDS[index]);

  if (achievement.tiers.length < 2 || !inOrder) {
    report(
      `${base}.tiers`,
      'A tiered achievement has 2 to 4 tiers, in the order Bronze, Silver, Gold, Diamond.',
    );
  }

  if (achievement.requirements.length !== 1) {
    report(
      `${base}.requirements`,
      'A tiered achievement has exactly one requirement. To combine requirements, make it a ' +
        'single achievement.',
    );
  }

  const [only] = achievement.requirements;

  if (only && !triggerOf(only.trigger).tiered) {
    report(
      `${base}.requirements.0.trigger`,
      `${quoted(triggerOf(only.trigger).label)} can’t be tiered. Use it in a single achievement.`,
    );
  }
}

function checkTargets(achievement: Achievement, base: string, report: Report): void {
  const ids = new Set(achievement.requirements.map((requirement) => requirement.id));

  achievement.tiers.forEach((tier, index) => {
    const path = `${base}.tiers.${index}.targets`;

    for (const requirement of achievement.requirements) {
      const trigger = triggerOf(requirement.trigger);
      const target = tier.targets[requirement.id];

      if (target === undefined) {
        report(
          `${path}.${requirement.id}`,
          `${tierName(achievement, tier)} needs a target for ${quoted(trigger.label)}.`,
        );
        continue;
      }

      if (target < trigger.target.min || target > trigger.target.max) {
        report(
          `${path}.${requirement.id}`,
          `Targets for ${quoted(trigger.label)} go from ${numbers.format(trigger.target.min)} ` +
            `to ${numbers.format(trigger.target.max)}.`,
        );
      }
    }

    for (const key of Object.keys(tier.targets)) {
      if (!ids.has(key)) {
        report(`${path}.${key}`, 'This target belongs to no requirement of this achievement.');
      }
    }

    const previous = index > 0 ? achievement.tiers[index - 1] : undefined;
    if (achievement.kind !== 'tiered' || !previous) return;

    for (const requirement of achievement.requirements) {
      const now = tier.targets[requirement.id];
      const before = previous.targets[requirement.id];

      if (now !== undefined && before !== undefined && now <= before) {
        report(
          `${path}.${requirement.id}`,
          `${TIER_LABELS[tier.id]} needs more than ${TIER_LABELS[previous.id]}.`,
        );
      }
    }
  });
}

function checkRewards(achievement: Achievement, base: string, report: Report): void {
  achievement.tiers.forEach((tier, index) => {
    const seen = new Set<string>();

    tier.rewards.forEach((reward, position) => {
      const path = `${base}.tiers.${index}.rewards.${position}`;
      const key = rewardKeyOf(reward);

      if (seen.has(key)) {
        report(
          path,
          reward.kind === 'xp'
            ? 'A tier gives XP once. Add the amounts together instead.'
            : 'This reward is already in this tier.',
        );
        return;
      }

      seen.add(key);

      if (reward.kind === 'xp') return;

      const opposite = reward.kind === 'add_role' ? 'remove_role' : 'add_role';

      if (seen.has(`${opposite}:${reward.roleId}`)) {
        report(path, 'A tier can’t both give and remove the same role. Keep one of the two.');
      }
    });
  });
}

function checkFilters(achievement: Achievement, base: string, report: Report): void {
  const xpLabel = quoted(triggerOf('leveling.activity_xp').label);
  const pointerLabel = quoted(triggerOf('achievements.unlocked').label);

  achievement.requirements.forEach((requirement, index) => {
    const path = `${base}.requirements.${index}`;
    const trigger = triggerOf(requirement.trigger);

    if (!trigger.filters.channels && requirement.channelIds.length > 0) {
      report(`${path}.channelIds`, `${quoted(trigger.label)} can’t be limited to channels.`);
    }

    if (!trigger.filters.channels && requirement.excludedChannelIds.length > 0) {
      report(`${path}.excludedChannelIds`, `${quoted(trigger.label)} can’t exclude channels.`);
    }

    if (requirement.xpSources !== undefined) {
      if (!trigger.filters.xpSources) {
        report(`${path}.xpSources`, `Only ${xpLabel} can choose XP sources.`);
      } else if (new Set(requirement.xpSources).size !== requirement.xpSources.length) {
        report(`${path}.xpSources`, 'Each XP source can be chosen once.');
      }
    }

    if (!trigger.filters.achievement) {
      if (requirement.achievementId !== undefined) {
        report(`${path}.achievementId`, `Only ${pointerLabel} points at another achievement.`);
      }

      if (requirement.tierId !== undefined) {
        report(`${path}.tierId`, `Only ${pointerLabel} asks for a tier of another achievement.`);
      }
    }
  });
}

function checkPrerequisites(
  achievement: Achievement,
  base: string,
  byId: ReadonlyMap<string, Achievement>,
  report: Report,
): void {
  achievement.requirements.forEach((requirement, index) => {
    if (requirement.trigger !== 'achievements.unlocked') return;

    const path = `${base}.requirements.${index}`;
    const targetId = requirement.achievementId;

    if (targetId === undefined) {
      report(`${path}.achievementId`, 'Pick the achievement members need to hold.');
      return;
    }

    if (targetId === achievement.id) {
      report(`${path}.achievementId`, 'An achievement can’t require itself.');
      return;
    }

    const target = byId.get(targetId);

    if (!target) {
      report(`${path}.achievementId`, 'That achievement doesn’t exist any more. Pick another one.');
      return;
    }

    const tierId = requirement.tierId;
    if (tierId === undefined) return;

    if (target.kind === 'single' && tierId !== 'single') {
      report(
        `${path}.tierId`,
        `${quoted(target.name)} is a single achievement, so it has no ${TIER_LABELS[tierId]} tier.`,
      );
    } else if (target.kind === 'tiered' && tierId === 'single') {
      report(`${path}.tierId`, `${quoted(target.name)} is tiered, so pick one of its tiers.`);
    } else if (!target.tiers.some((tier) => tier.id === tierId)) {
      report(`${path}.tierId`, `${quoted(target.name)} has no ${TIER_LABELS[tierId]} tier.`);
    }
  });
}

function checkLoops(achievements: readonly Achievement[], report: Report): void {
  const byId = firstById(achievements);
  const indexOf = new Map(achievements.map((achievement, index) => [achievement, index]));
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];

  const visit = (achievement: Achievement): void => {
    state.set(achievement.id, 'open');
    stack.push(achievement.id);

    achievement.requirements.forEach((requirement, position) => {
      if (requirement.trigger !== 'achievements.unlocked') return;

      const targetId = requirement.achievementId;
      if (targetId === undefined || targetId === achievement.id) return;

      const target = byId.get(targetId);
      if (!target) return;

      const seen = state.get(targetId);

      if (seen === 'open') {
        const loop = [...stack.slice(stack.indexOf(targetId)), targetId];
        const names = loop.map((id) => byId.get(id)?.name ?? id).join(' → ');

        report(
          `achievements.${indexOf.get(achievement)}.requirements.${position}.achievementId`,
          `These achievements depend on each other in a loop: ${names}.`,
        );
      } else if (seen === undefined) {
        visit(target);
      }
    });

    stack.pop();
    state.set(achievement.id, 'done');
  };

  for (const achievement of byId.values()) {
    if (!state.has(achievement.id)) visit(achievement);
  }
}

function checkDates(
  achievement: Achievement,
  previous: Achievement | undefined,
  base: string,
  now: number,
  report: Report,
): void {
  if (achievement.endsAt === undefined) return;

  const endsAt = Date.parse(achievement.endsAt);

  if (achievement.startsAt !== undefined && endsAt <= Date.parse(achievement.startsAt)) {
    report(`${base}.endsAt`, 'The deadline must be after the start.');
  }

  const unchanged = previous?.endsAt !== undefined && Date.parse(previous.endsAt) === endsAt;

  if (!unchanged && endsAt < now) {
    report(`${base}.endsAt`, 'The deadline is in the past. Pick a later one, or clear it.');
  }
}

function checkAnnouncement(achievement: Achievement, base: string, report: Report): void {
  const { announcement } = achievement;
  if (announcement.mode !== 'custom') return;

  if (announcement.destination === undefined) {
    report(`${base}.announcement.destination`, 'Pick where to announce this achievement.');
  } else if (announcement.destination === 'channel' && announcement.channelId === undefined) {
    report(`${base}.announcement.channelId`, 'Pick the channel to announce this achievement in.');
  }

  if (announcement.message === undefined) {
    report(`${base}.announcement.message`, 'Write the announcement for this achievement.');
  }
}

function checkVersions(
  achievement: Achievement,
  previous: Achievement | undefined,
  base: string,
  report: Report,
): void {
  if (!previous) return;

  achievement.requirements.forEach((requirement, index) => {
    const stored = previous.requirements.find((candidate) => candidate.id === requirement.id);
    if (!stored) return;

    const lowered = requirement.version < stored.version;
    const unbumped =
      requirement.version === stored.version && revisionOf(requirement) !== revisionOf(stored);

    if (lowered || unbumped) report(`${base}.requirements.${index}.version`, VERSION_CHANGED);
  });
}

function checkModuleAnnouncements(config: AchievementsConfig, report: Report): void {
  if (
    config.announcement.destination === 'channel' &&
    config.announcement.channelId === undefined
  ) {
    report('announcement.channelId', 'Pick the channel to announce achievements in.');
  }

  if (
    config.announcement.fallback === 'channel' &&
    config.announcement.fallbackChannelId === undefined
  ) {
    report('announcement.fallbackChannelId', 'Pick the channel to fall back to.');
  }

  if (config.almostThere.destination === 'channel' && config.almostThere.channelId === undefined) {
    report('almostThere.channelId', 'Pick the channel for “Almost there” reminders.');
  }
}

export function validateConfig(
  next: AchievementsConfig,
  before: AchievementsConfig,
  now: number = Date.now(),
): ConfigWriteIssue[] {
  const issues: ConfigWriteIssue[] = [];
  const report: Report = (path, message) => {
    issues.push({ path, message });
  };

  const byId = firstById(next.achievements);
  const stored = firstById(before.achievements);
  const ids = new Set<string>();

  next.achievements.forEach((achievement, index) => {
    const base = `achievements.${index}`;
    const previous = stored.get(achievement.id);

    if (ids.has(achievement.id)) {
      report(`${base}.id`, `Another achievement already uses the ID ${quoted(achievement.id)}.`);
    }
    ids.add(achievement.id);

    checkShape(achievement, base, report);
    checkTargets(achievement, base, report);
    checkRewards(achievement, base, report);
    checkFilters(achievement, base, report);
    checkPrerequisites(achievement, base, byId, report);
    checkDates(achievement, previous, base, now, report);
    checkAnnouncement(achievement, base, report);
    checkVersions(achievement, previous, base, report);

    if (previous?.status === 'archived' && achievement.status === 'draft') {
      report(
        `${base}.status`,
        'An archived achievement can go back to paused or active, not to draft.',
      );
    }
  });

  checkLoops(next.achievements, report);
  checkModuleAnnouncements(next, report);

  return issues;
}
