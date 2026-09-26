import type { EventListener, EventType, ProtonEvent } from '@proton/core';
import { collectAchievementUnlocked } from './collect/achievements.ts';
import { collectApplicationAccepted } from './collect/applications.ts';
import { type CollectorEngine, type Ctx, ENGINE, own } from './collect/common.ts';
import {
  collectDropClaimed,
  collectGiveawayCancelled,
  collectGiveawayDrawn,
  collectGiveawayEntered,
} from './collect/giveaways.ts';
import { collectMemberJoined, collectMemberLeft, collectMemberUpdated } from './collect/members.ts';
import { collectMessage } from './collect/messages.ts';
import { collectReaction } from './collect/reactions.ts';
import { collectStarboardPost } from './collect/starboard.ts';
import { collectLevelGained, collectXpAwarded } from './collect/xp.ts';
import { type AchievementsConfig, MODULE_ID } from './config.ts';
import { type AchievementsDeps, describeUnbound } from './deps.ts';
import {
  handleConfigChanged,
  handleGuildAvailable,
  handleJobRequest,
  handleRetryRequest,
  handleXpGranted,
} from './engine.ts';
import { closeAllVoice, handleVoiceState, reconcileVoice } from './voice.ts';

type EventHandler<R = void> = (ctx: Ctx, deps: AchievementsDeps, event: ProtonEvent) => Promise<R>;

export interface ListenerEngine extends CollectorEngine {
  handleConfigChanged: EventHandler<{ turnedOff: boolean; turnedOn: boolean }>;
  handleGuildAvailable: EventHandler;
  handleXpGranted: EventHandler;
  handleRetryRequest: EventHandler;
  handleJobRequest: EventHandler;
}

export const LISTENER_ENGINE: ListenerEngine = {
  ...ENGINE,
  handleConfigChanged,
  handleGuildAvailable,
  handleXpGranted,
  handleRetryRequest,
  handleJobRequest,
};

type Collector = (
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine,
) => Promise<void>;

const COLLECTORS = {
  'message.created': collectMessage,
  'reaction.added': collectReaction,
  'member.joined': collectMemberJoined,
  'member.updated': collectMemberUpdated,
  'member.left': collectMemberLeft,
  'starboard.message_posted': collectStarboardPost,
  'giveaways.entered': collectGiveawayEntered,
  'giveaways.drop_claimed': collectDropClaimed,
  'giveaways.ended': collectGiveawayDrawn,
  'giveaways.rerolled': collectGiveawayDrawn,
  'giveaways.cancelled': collectGiveawayCancelled,
  'xp.awarded': collectXpAwarded,
  'xp.level_gained': collectLevelGained,
  'applications.accepted': collectApplicationAccepted,
  'achievements.unlocked': collectAchievementUnlocked,
} satisfies Partial<Record<EventType, Collector>>;

type CollectedType = keyof typeof COLLECTORS;

const COLLECTED_TYPES = Object.keys(COLLECTORS) as CollectedType[];

function isCollected(type: EventType): type is CollectedType {
  return Object.hasOwn(COLLECTORS, type);
}

export const ACHIEVEMENT_LISTENER_TYPES: readonly EventType[] = [
  ...COLLECTED_TYPES,
  'voice.state_updated',
  'guild.available',
  'xp.granted',
  'achievements.reward_retry_requested',
  'achievements.job_requested',
  'proton.config_changed',
];

export function createAchievementsListeners(
  deps: AchievementsDeps,
  engine: ListenerEngine = LISTENER_ENGINE,
): EventListener<AchievementsConfig>[] {
  function unbound(ctx: Ctx, what: string): boolean {
    if (deps.store) return false;

    ctx.logger.error(describeUnbound(what, ['store']), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return true;
  }

  function relay(
    type: EventType,
    what: string,
    handle: (ctx: Ctx, event: ProtonEvent) => Promise<void>,
    concerns: (event: ProtonEvent) => boolean = () => true,
    whileOff = false,
  ): EventListener<AchievementsConfig> {
    return {
      types: [type],
      async handler(event, ctx) {
        if (!whileOff && !ctx.config.enabled) return;
        if (!concerns(event)) return;
        if (unbound(ctx, what)) return;
        await handle(ctx, event);
      },
    };
  }

  return [
    {
      types: COLLECTED_TYPES,
      async handler(event, ctx) {
        if (!ctx.config.enabled) return;
        if (!isCollected(event.type)) return;
        if (unbound(ctx, 'activity counting')) return;

        const collect: Collector = COLLECTORS[event.type];
        await collect(ctx, deps, event, engine);
      },
    },

    relay('voice.state_updated', 'voice time', (ctx, event) =>
      handleVoiceState(ctx, deps, event, engine),
    ),

    relay('guild.available', 'reconnect recovery', async (ctx, event) => {
      await engine.handleGuildAvailable(ctx, deps, event);
      await reconcileVoice(ctx, deps, event);
    }),

    {
      types: ['proton.config_changed'],
      async handler(event, ctx) {
        if (own(event.payload, 'moduleId') !== MODULE_ID) return;
        if (unbound(ctx, 'period tracking')) return;

        const change = await engine.handleConfigChanged(ctx, deps, event);
        if (change.turnedOff) await closeAllVoice(ctx, deps, 'disabled');
      },
    },

    relay(
      'xp.granted',
      'XP reward confirmation',
      (ctx, event) => engine.handleXpGranted(ctx, deps, event),
      (event) => own(event.payload, 'sourceModule') === MODULE_ID,
      true,
    ),

    // The engine answers the api's mailbox and fails the job itself when the module is off.
    relay(
      'achievements.reward_retry_requested',
      'reward retries',
      (ctx, event) => engine.handleRetryRequest(ctx, deps, event),
      undefined,
      true,
    ),

    relay(
      'achievements.job_requested',
      'rebuilds and re-checks',
      (ctx, event) => engine.handleJobRequest(ctx, deps, event),
      undefined,
      true,
    ),
  ];
}
