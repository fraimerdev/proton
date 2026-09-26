import {
  type Causation,
  type EventListener,
  type EventType,
  type ModuleContext,
  type XpGrantRequested,
  xpGrantedSchema,
  xpGrantRequestedSchema,
} from '@proton/core';
import type { LevelingConfig } from './config.ts';
import { bindXp, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { MODULE_ID } from './perform.ts';
import { publishFact, publishXpAwarded } from './publish.ts';
import type { GrantResult } from './store.ts';

export const XP_GRANT_EVENT_TYPES: EventType[] = ['xp.grant_requested'];

export const LEVELING_OFF_REASON = 'Leveling is off in this server.';

const REASON_MAX = 300;

type Outcome = { status: 'granted'; result: GrantResult } | { status: 'refused'; reason: string };

function rewardCausation(request: XpGrantRequested): Causation {
  return {
    kind: 'reward',
    rootId: request.causation.rootId,
    depth: request.causation.depth,
    grantId: request.grantId,
    sourceModule: request.sourceModule,
  };
}

async function answer(
  ctx: ModuleContext<LevelingConfig>,
  request: XpGrantRequested,
  outcome: Outcome,
): Promise<void> {
  const base = {
    guildId: request.guildId,
    userId: request.userId,
    grantId: request.grantId,
    sourceModule: request.sourceModule,
  };

  const payload = xpGrantedSchema.parse(
    outcome.status === 'granted'
      ? {
          ...base,
          status: 'granted',
          amount: request.amount,
          xp: outcome.result.xp,
          level: outcome.result.level,
          previousLevel: outcome.result.previousLevel,
        }
      : { ...base, status: 'refused', amount: 0, reason: outcome.reason.slice(0, REASON_MAX) },
  );

  await publishFact(
    ctx,
    'xp.granted',
    outcome.status === 'granted' ? request.grantId : `${request.grantId}:refused`,
    payload,
    `${outcome.status === 'granted' ? 'gave' : 'refused'} the ${request.amount} XP ` +
      `${request.sourceModule} asked for (${request.grantId})`,
  );
}

export function createXpGrantListener(deps: LevelingDeps): EventListener<LevelingConfig> {
  return {
    types: XP_GRANT_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.guildId === null) return;

      const parsed = xpGrantRequestedSchema.safeParse(event.payload);
      if (!parsed.success) {
        ctx.logger.error(
          'leveling ignored an XP grant request it could not read, so no XP was given and no ' +
            `answer was sent: ${parsed.error.message}`,
          { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
        );
        return;
      }

      const request = parsed.data;
      if (request.guildId !== ctx.guildId) {
        ctx.logger.error(
          `leveling ignored XP grant ${request.grantId}: it names server ${request.guildId} but ` +
            'arrived for this one.',
          { guildId: ctx.guildId, moduleId: MODULE_ID, eventId: event.id },
        );
        return;
      }

      if (!ctx.config.enabled) {
        await answer(ctx, request, { status: 'refused', reason: LEVELING_OFF_REASON });
        return;
      }

      const bound = bindXp(deps);
      if ('unbound' in bound) {
        const reason = describeUnbound('reward XP', bound.unbound);
        ctx.logger.error(reason, { guildId: ctx.guildId, moduleId: MODULE_ID });
        await answer(ctx, request, { status: 'refused', reason });
        return;
      }

      let result: GrantResult;
      try {
        result = await bound.xp.grant({
          guildId: request.guildId,
          userId: request.userId,
          amount: request.amount,
          grantId: request.grantId,
          sourceModule: request.sourceModule,
          causation: request.causation,
          now: event.occurredAt,
        });
      } catch (error) {
        ctx.logger.error(
          `leveling could not give the ${request.amount} XP ${request.sourceModule} asked for ` +
            `${request.userId} (${request.grantId}): ${
              error instanceof Error ? error.message : String(error)
            }. The request is delivered again, and a replay credits it at most once.`,
          { guildId: ctx.guildId, moduleId: MODULE_ID, userId: request.userId },
        );
        throw error;
      }

      const causation = rewardCausation(request);

      await applyLevelUp(
        ctx,
        {
          userId: request.userId,
          previousLevel: result.previousLevel,
          level: result.level,
          xp: result.xp,
          source: 'reward',
          idempotencyRoot: `leveling:grant:${request.grantId}`,
          originChannelId: request.originChannelId,
          gained: request.amount,
          causation,
        },
        deps,
      );

      await publishXpAwarded(ctx, `grant:${request.grantId}`, {
        userId: request.userId,
        amount: request.amount,
        source: 'reward',
        channelId: request.originChannelId,
        activityAt: event.occurredAt,
        xp: result.xp,
        level: result.level,
        causation,
      });

      await answer(ctx, request, { status: 'granted', result });
    },
  };
}
