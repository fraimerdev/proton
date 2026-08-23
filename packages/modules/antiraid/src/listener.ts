import {
  type EventListener,
  type EventType,
  type ModuleContext,
  type ProtonEvent,
  RATE_WINDOW_GUILD_SCOPE,
  type RateWindowStore,
} from '@proton/core';
import { type AntiraidConfig, readScoreSettings } from './config.ts';
import { readJoin } from './join.ts';
import { planResponse, RESPONSE_LABELS, responseUnconfigured } from './response.ts';
import { MAX_JOIN_SCORE, scoreJoin } from './score.ts';

export const ANTIRAID_MODULE_ID = 'antiraid';

export const ANTIRAID_ACTOR = 'proton:antiraid';

export const JOIN_RATE_RULE_ID = `${ANTIRAID_MODULE_ID}:join-rate`;

export const ANTIRAID_EVENT_TYPES: EventType[] = ['member.joined'];

export interface AntiraidDeps {
  rateWindow?: RateWindowStore;
}

const UNBOUND_WINDOW =
  'Anti-raid is enabled for this guild but no join-rate window is bound, so joins are not ' +
  'being counted and no raid can be detected. The process running modules must construct ' +
  'RedisRateWindow(redis) and pass it to createAntiraidModule({ rateWindow }).';

async function announceRaid(
  ctx: ModuleContext<AntiraidConfig>,
  event: ProtonEvent,
  joinsInWindow: number,
): Promise<void> {
  const channelId = ctx.config.alertChannelId;
  if (!channelId) return;

  const parts = [
    `**Raid mode.** ${joinsInWindow} accounts joined within ${ctx.config.joinWindow}, at or ` +
      `above this server's threshold of ${ctx.config.joinThreshold}.`,
    `Joins scoring ${ctx.config.scoreThreshold}/${MAX_JOIN_SCORE} or higher are ` +
      `${RESPONSE_LABELS[ctx.config.response]}.`,
  ];

  const unconfigured = responseUnconfigured(ctx.config);
  if (unconfigured) parts.push(unconfigured);

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: ANTIRAID_MODULE_ID,
    kind: 'send',
    actorId: ANTIRAID_ACTOR,

    idempotencyKey: `antiraid:${event.id}:alert`,

    dryRun: false,
    payload: { channelId, content: parts.join(' ').slice(0, 2000) },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `anti-raid could not post the raid alert: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID, channelId },
    );
  }
}

async function publishRaid(
  ctx: ModuleContext<AntiraidConfig>,
  event: ProtonEvent,
  joinsInWindow: number,
): Promise<void> {
  if (!ctx.publish) return;

  try {
    await ctx.publish('proton.security_tripped', event.id, {
      guildId: ctx.guildId,
      moduleId: ANTIRAID_MODULE_ID,
      trigger: 'join-rate',
      actorId: null,
      summary:
        `${joinsInWindow} accounts joined within ${ctx.config.joinWindow}, at or above this ` +
        `server's threshold of ${ctx.config.joinThreshold}.`,
      actionsTaken: [
        `joins scoring ${ctx.config.scoreThreshold} or higher are ${ctx.config.response}`,
      ],
      ownerExempt: false,
    });
  } catch (error) {
    ctx.logger.error(
      `anti-raid tripped but could not publish it, so no Proton log was posted: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID },
    );
  }
}

export function createJoinListener(deps: AntiraidDeps): EventListener<AntiraidConfig> {
  return {
    types: ANTIRAID_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      const facts = readJoin(event);
      if (!facts) {
        ctx.logger.warn('a member.joined event carried no user id, so it was not screened', {
          guildId: ctx.guildId,
          moduleId: ANTIRAID_MODULE_ID,
          eventId: event.id,
        });
        return;
      }

      if (facts.isBot) return;

      if (!deps.rateWindow) {
        ctx.logger.error(UNBOUND_WINDOW, { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID });
        return;
      }

      const parsed = readScoreSettings(ctx.config);
      if ('invalid' in parsed) {
        ctx.logger.error(parsed.invalid, { guildId: ctx.guildId, moduleId: ANTIRAID_MODULE_ID });
        return;
      }

      const now = event.occurredAt;

      const { count, tripped } = await deps.rateWindow.hit({
        guildId: ctx.guildId,
        ruleId: JOIN_RATE_RULE_ID,

        actorId: RATE_WINDOW_GUILD_SCOPE,
        windowMs: parsed.joinWindowMs,
        limit: ctx.config.joinThreshold,

        member: event.id,
        now,
      });

      const score = scoreJoin(
        {
          joinsInWindow: count,
          accountAgeMs:
            facts.accountCreatedAt === null ? null : Math.max(0, now - facts.accountCreatedAt),
          avatarless: facts.avatarless,
        },
        parsed.settings,
      );

      if (tripped) {
        await announceRaid(ctx, event, count);
        await publishRaid(ctx, event, count);
      }

      if (score.score < ctx.config.scoreThreshold) {
        if (score.burst) {
          ctx.logger.info('join scored below the threshold during a burst and was let through', {
            guildId: ctx.guildId,
            moduleId: ANTIRAID_MODULE_ID,
            userId: facts.userId,
            score: score.score,
            threshold: ctx.config.scoreThreshold,
          });
        }
        return;
      }

      const planned = planResponse(ctx.config, facts.userId, score);
      if ('unconfigured' in planned) {
        ctx.logger.error(planned.unconfigured, {
          guildId: ctx.guildId,
          moduleId: ANTIRAID_MODULE_ID,
          userId: facts.userId,
        });
        return;
      }

      const { plan } = planned;
      const result = await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: ANTIRAID_MODULE_ID,
        kind: plan.kind,
        targetId: facts.userId,
        actorId: ANTIRAID_ACTOR,
        reason: plan.reason,
        payload: plan.payload,
        dryRun: false,

        idempotencyKey: `antiraid:${event.id}:response`,
      });

      if (result.status === 'failed_precheck' || result.status === 'failed_api') {
        ctx.logger.warn(
          `anti-raid could not ${plan.kind} ${facts.userId}: ${
            result.failure?.humanReason ?? 'no reason was reported'
          }`,
          {
            guildId: ctx.guildId,
            moduleId: ANTIRAID_MODULE_ID,
            userId: facts.userId,
            code: result.failure?.code,
          },
        );
        return;
      }

      ctx.logger.info(`anti-raid ${plan.kind}: ${result.status}`, {
        guildId: ctx.guildId,
        moduleId: ANTIRAID_MODULE_ID,
        userId: facts.userId,
        score: score.score,
        response: ctx.config.response,
        caseId: result.caseId,
      });
    },
  };
}
