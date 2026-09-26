import { TIER_COLOURS, TIER_LABELS } from '@proton/cards/design';
import type {
  SimulationAdapter,
  SimulationAttachment,
  SimulationBuild,
  SimulationDescriptor,
  SimulationInput,
  SimulationScene,
  TierId,
} from '@proton/core';
import { isComponentsV2, readChoice, readInteger, readText } from '@proton/core';
import {
  type Achievement,
  type AchievementsConfig,
  type Badge,
  isSilentMessage,
  MODULE_ID,
  TIERED_IDS,
} from './config.ts';
import {
  ACHIEVEMENT_SURFACES,
  type AchievementMessageKind,
  ALMOST_THERE_BASE_PATH,
  ANNOUNCEMENT_BASE_PATH,
  almostThereRoute,
  BADGE_FILENAME,
  closestTier,
  isDirectMessageKind,
  isUnlockKind,
  type MessageRoute,
  previewFacts,
  REWARD_PREVIEWS,
  renderAchievementMessage,
  SAMPLE_DEFINITION,
  unlockRoute,
  withBadgeThumbnail,
} from './placeholders.ts';

const GONE =
  'that achievement is no longer in this server’s settings. Reload the page and try again.';

const NOTE =
  'Nothing is earned or saved and no role or XP is given. Progress and rewards are sample values.';

const PERCENT_MIN = 50;
const PERCENT_MAX = 99;
const PERCENT_FALLBACK = 80;

const ACHIEVEMENT_INPUT: SimulationInput = {
  key: 'achievement',
  label: 'Achievement',
  help: 'Leave it empty to use a sample achievement.',
  kind: 'text',
  maxLength: 32,
  fallback: '',
  fixed: true,
};

function tierInput(fallback: TierId): SimulationInput {
  return {
    key: 'tier',
    label: 'Tier',
    help: 'Achievements without tiers ignore this. A tier the achievement lacks uses the highest one below it.',
    kind: 'choice',
    options: TIERED_IDS.map((id) => ({ value: id, label: TIER_LABELS[id] })),
    fallback,
  };
}

const REWARDS_INPUT: SimulationInput = {
  key: 'rewards',
  label: 'Rewards',
  kind: 'choice',
  options: [
    { value: 'given', label: 'Given' },
    { value: 'pending', label: 'Still on their way' },
    { value: 'failed', label: 'Couldn’t be given' },
  ],
  fallback: 'given',
};

const PERCENT_INPUT: SimulationInput = {
  key: 'percent',
  label: 'Progress towards the tier (%)',
  kind: 'integer',
  min: PERCENT_MIN,
  max: PERCENT_MAX,
  fallback: PERCENT_FALLBACK,
};

const UNLOCK_TIER_FALLBACK: TierId = 'gold';

const ALMOST_TIER_FALLBACK: TierId = 'diamond';

type Inputs = Readonly<Record<string, string | number | boolean>>;

type Lookup = { ok: true; achievement: Achievement | null } | { ok: false };

function achievementFor(config: AchievementsConfig, inputs: Inputs): Lookup {
  const id = readText(inputs, 'achievement', '').trim();
  if (id === '') return { ok: true, achievement: null };

  const achievement = config.achievements.find((candidate) => candidate.id === id);
  return achievement === undefined ? { ok: false } : { ok: true, achievement };
}

function refused(humanReason: string): SimulationBuild {
  return { ok: false, humanReason, diagnostics: [] };
}

export function badgeColour(badge: Badge, tier: TierId): number {
  return badge.colour === 'tier' ? TIER_COLOURS[tier] : badge.colour;
}

export function badgeAttachment(achievement: Achievement, tier: TierId): SimulationAttachment {
  const { badge } = achievement;

  return {
    filename: BADGE_FILENAME,
    card: {
      kind: 'badge',
      shape: badge.shape,
      colour: badgeColour(badge, tier),
      icon: badge.icon,
      ...(badge.assetId === undefined ? {} : { assetId: badge.assetId }),
    },
  };
}

function routeFor(
  kind: AchievementMessageKind,
  config: AchievementsConfig,
  achievement: Achievement | null,
): MessageRoute | string {
  if (!isUnlockKind(kind)) {
    if (achievement !== null && !achievement.almostThere.enabled) {
      return (
        `almost there reminders are off for ${achievement.name}, so members aren’t told when ` +
        'they’re close to it. Turn them on under its Schedule tab to test this.'
      );
    }
    return almostThereRoute(config);
  }

  const route = unlockRoute(config, achievement);
  if (route !== null) return route;

  return (
    `${achievement?.name ?? 'this achievement'} is set not to announce, so earning it posts ` +
    'nothing. Choose Server default or Custom under its Announcement tab to test it.'
  );
}

function silentReason(kind: AchievementMessageKind): string {
  return isUnlockKind(kind)
    ? 'the unlock announcement is empty, so earning an achievement posts nothing. Write something ' +
        'before testing it.'
    : 'the almost there message is empty, so Proton sends nothing. Write something before ' +
        'testing it.';
}

function buildFor(kind: AchievementMessageKind): SimulationAdapter<AchievementsConfig>['build'] {
  const unlock = isUnlockKind(kind);
  const dm = isDirectMessageKind(kind);

  return (config, scene: SimulationScene): SimulationBuild => {
    const found = achievementFor(config, scene.inputs);
    if (!found.ok) return refused(GONE);

    const { achievement } = found;
    const route = routeFor(kind, config, achievement);
    if (typeof route === 'string') return refused(route);
    if (isSilentMessage(route.message)) return refused(silentReason(kind));

    const definition = achievement ?? SAMPLE_DEFINITION;
    const wanted = readChoice(
      scene.inputs,
      'tier',
      TIERED_IDS,
      unlock ? UNLOCK_TIER_FALLBACK : ALMOST_TIER_FALLBACK,
    );
    const tier = closestTier(definition, wanted)?.id ?? wanted;

    const facts = previewFacts(config, achievement, {
      kind,
      now: scene.now,
      tier,
      rewards: readChoice(scene.inputs, 'rewards', REWARD_PREVIEWS, 'given'),
      percent: readInteger(scene.inputs, 'percent', PERCENT_FALLBACK),
      subject: {
        userId: scene.subject.user.id,
        user: scene.subject.user,
        member: scene.subject.member,
      },
      server: scene.server,
      bot: scene.bot,
      originChannel: scene.originChannel,
      destinationChannel: dm ? null : scene.destinationChannel,
    });

    const rendered = renderAchievementMessage(
      kind,
      route.message,
      facts,
      scene.now,
      route.basePath,
    );
    if (!rendered.ok) {
      return { ok: false, humanReason: rendered.humanReason, diagnostics: rendered.diagnostics };
    }

    const badged = unlock && config.announcement.attachBadge && !isComponentsV2(rendered.message);
    const named = `${definition.name}${tier === 'single' ? '' : ` (${TIER_LABELS[tier]})`}`;

    return {
      ok: true,
      caption: unlock
        ? `${scene.subject.displayName} earning ${named}`
        : `${scene.subject.displayName} close to ${named}`,
      diagnostics: rendered.diagnostics,
      output: {
        kind: 'message',
        message: badged ? withBadgeThumbnail(rendered.message) : rendered.message,
        attachments: badged ? [badgeAttachment(definition, tier)] : [],
      },
    };
  };
}

const DESCRIPTORS: Readonly<Record<AchievementMessageKind, SimulationDescriptor>> = {
  unlocked: {
    id: 'achievements.unlocked',
    moduleId: MODULE_ID,
    label: 'Unlock announcement',
    summary: 'What Proton posts when a member earns an achievement or a new tier.',
    surfaceId: ACHIEVEMENT_SURFACES.unlocked.id,
    configPath: ANNOUNCEMENT_BASE_PATH,
    output: 'message',
    delivery: 'channel',
    channelPath: 'announcement.channelId',
    subject: true,
    inputs: [ACHIEVEMENT_INPUT, tierInput(UNLOCK_TIER_FALLBACK), REWARDS_INPUT],
    note: NOTE,
  },
  unlocked_dm: {
    id: 'achievements.unlocked_dm',
    moduleId: MODULE_ID,
    label: 'Unlock DM',
    summary: 'What Proton sends a member by DM when they earn an achievement or a new tier.',
    surfaceId: ACHIEVEMENT_SURFACES.unlocked_dm.id,
    configPath: ANNOUNCEMENT_BASE_PATH,
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [ACHIEVEMENT_INPUT, tierInput(UNLOCK_TIER_FALLBACK), REWARDS_INPUT],
    note: NOTE,
  },
  almost_there: {
    id: 'achievements.almost_there',
    moduleId: MODULE_ID,
    label: 'Almost there message',
    summary: 'What Proton posts when a member is close to the next tier of an achievement.',
    surfaceId: ACHIEVEMENT_SURFACES.almost_there.id,
    configPath: ALMOST_THERE_BASE_PATH,
    output: 'message',
    delivery: 'channel',
    channelPath: 'almostThere.channelId',
    subject: true,
    inputs: [ACHIEVEMENT_INPUT, tierInput(ALMOST_TIER_FALLBACK), PERCENT_INPUT],
    note: NOTE,
  },
  almost_there_dm: {
    id: 'achievements.almost_there_dm',
    moduleId: MODULE_ID,
    label: 'Almost there DM',
    summary: 'What Proton sends a member by DM when they’re close to the next tier.',
    surfaceId: ACHIEVEMENT_SURFACES.almost_there_dm.id,
    configPath: ALMOST_THERE_BASE_PATH,
    output: 'message',
    delivery: 'dm',
    subject: true,
    inputs: [ACHIEVEMENT_INPUT, tierInput(ALMOST_TIER_FALLBACK), PERCENT_INPUT],
    note: NOTE,
  },
};

function unlockDestination(config: AchievementsConfig, inputs: Inputs): string | null {
  const found = achievementFor(config, inputs);
  if (!found.ok) return null;

  const route = unlockRoute(config, found.achievement);
  return route?.destination === 'channel' ? route.channelId : null;
}

function almostThereDestination(config: AchievementsConfig): string | null {
  const route = almostThereRoute(config);
  return route.destination === 'channel' ? route.channelId : null;
}

export const ACHIEVEMENTS_UNLOCKED_SIMULATION: SimulationAdapter<AchievementsConfig> = {
  descriptor: DESCRIPTORS.unlocked,
  destination: unlockDestination,
  build: buildFor('unlocked'),
};

export const ACHIEVEMENTS_UNLOCKED_DM_SIMULATION: SimulationAdapter<AchievementsConfig> = {
  descriptor: DESCRIPTORS.unlocked_dm,
  build: buildFor('unlocked_dm'),
};

export const ACHIEVEMENTS_ALMOST_THERE_SIMULATION: SimulationAdapter<AchievementsConfig> = {
  descriptor: DESCRIPTORS.almost_there,
  destination: almostThereDestination,
  build: buildFor('almost_there'),
};

export const ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION: SimulationAdapter<AchievementsConfig> = {
  descriptor: DESCRIPTORS.almost_there_dm,
  build: buildFor('almost_there_dm'),
};

export const achievementsSimulations: SimulationAdapter<AchievementsConfig>[] = [
  ACHIEVEMENTS_UNLOCKED_SIMULATION,
  ACHIEVEMENTS_UNLOCKED_DM_SIMULATION,
  ACHIEVEMENTS_ALMOST_THERE_SIMULATION,
  ACHIEVEMENTS_ALMOST_THERE_DM_SIMULATION,
];
