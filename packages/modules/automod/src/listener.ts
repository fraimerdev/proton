import type { ActionKind, EventListener, EventType } from '@proton/core';
import type { AutomodHit } from './checks.ts';
import { type AutomodConfig, readSettings } from './config.ts';
import { type AutomodDeps, bindDeps, describeUnbound, MODULE_ID } from './deps.ts';
import { isExempt } from './exempt.ts';
import { readMessage } from './message.ts';
import { screen } from './pipeline.ts';
import { respond } from './respond.ts';

export const AUTOMOD_EVENT_TYPES: EventType[] = ['message.created', 'message.updated'];

// The alert reads to a moderator, so it says what happened rather than naming the action kind the
// executor was handed.
const WHAT_THEY_GOT: Partial<Record<ActionKind, string>> = {
  warn: 'They were warned.',
  timeout: 'They were timed out.',
  kick: 'They were removed from the server.',
  ban: 'They were banned.',
};

function describe(hit: AutomodHit, also: readonly AutomodHit[]): string {
  const extra = also.length > 0 ? ` It also matched ${also.map((h) => h.check).join(', ')}.` : '';
  return `**${hit.check}** (${hit.severity}) — ${hit.humanReason}.${extra}`;
}

export function createAutomodListener(deps: AutomodDeps): EventListener<AutomodConfig> {
  return {
    types: AUTOMOD_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;
      if (event.guildId === null) return;

      const bound = bindDeps(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound(bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      const facts = readMessage(event.payload);
      if (!facts) return;

      const state = await bound.deps.guildState.get(ctx.guildId);
      const exempt = isExempt({
        facts,
        config: ctx.config,
        botUserId: bound.deps.botUserId,
        state,
      });
      if (exempt) return;

      const settings = readSettings(ctx.config);
      if ('invalid' in settings) {
        ctx.logger.error(settings.invalid, { guildId: ctx.guildId, moduleId: MODULE_ID });
        return;
      }

      const verdict = await screen({
        facts,
        config: ctx.config,
        settings: settings.settings,
        guildId: ctx.guildId,
        rateWindow: bound.deps.rateWindow,
        eventId: event.id,
        now: event.occurredAt,
      });

      if (!verdict.matched) return;

      ctx.logger.info(`automod matched ${verdict.hit.check} on ${facts.messageId}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: facts.authorId,
        severity: verdict.hit.severity,
      });

      const outcome = await respond({
        ctx,
        facts,
        settings: settings.settings,
        hit: verdict.hit,
        also: verdict.also,
        eventId: event.id,
        now: event.occurredAt,
      });

      for (const detail of outcome.failures) {
        ctx.logger.error(`automod: ${detail}`, { guildId: ctx.guildId, moduleId: MODULE_ID });
      }

      const alertChannelId = ctx.config.alertChannelId;
      if (!alertChannelId) return;

      const lines = [
        `Automod matched a message from <@${facts.authorId}> in <#${facts.channelId}>.`,
        describe(verdict.hit, verdict.also),
        outcome.deleted ? 'The message was deleted.' : 'The message was left up.',
        (outcome.action ? WHAT_THEY_GOT[outcome.action] : null) ??
          'Nothing was done to the member.',
        ...outcome.failures.map((detail) => `⚠ ${detail}`),
      ];

      await ctx.executor.execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'send',
        actorId: MODULE_ID,
        idempotencyKey: `${MODULE_ID}:${ctx.guildId}:${facts.messageId}:alert`,
        dryRun: false,
        record: false,
        payload: {
          channelId: alertChannelId,
          content: lines.join('\n').slice(0, 2000),
          // The alert quotes what a member wrote, so it must never be able to ping the server.
          allowedMentions: { parse: [] },
        },
      });
    },
  };
}
