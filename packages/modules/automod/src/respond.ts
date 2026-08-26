import {
  type ActionKind,
  type ActionResult,
  MAX_TIMEOUT_MS,
  type ModuleContext,
} from '@proton/core';
import type { AutomodHit } from './checks.ts';
import {
  type ActiveSeverity,
  type AutomodConfig,
  type AutomodSettings,
  deletesAt,
  responseFor,
} from './config.ts';
import { MODULE_ID } from './deps.ts';
import type { MessageFacts } from './message.ts';

export interface RespondInput {
  ctx: ModuleContext<AutomodConfig>;
  facts: MessageFacts;
  settings: AutomodSettings;
  hit: AutomodHit;
  also: AutomodHit[];
  eventId: string;
  now: number;
}

export interface RespondOutcome {
  deleted: boolean;
  action: ActionKind | null;
  failures: string[];
}

function timeoutMs(settings: AutomodSettings, severity: ActiveSeverity): number {
  const requested = severity === 'high' ? settings.highTimeoutMs : settings.mediumTimeoutMs;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

function failure(result: ActionResult): string | null {
  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    return result.failure?.humanReason ?? 'no reason was reported';
  }
  return null;
}

export async function respond(input: RespondInput): Promise<RespondOutcome> {
  const { ctx, facts, hit } = input;
  const config = ctx.config;
  const outcome: RespondOutcome = { deleted: false, action: null, failures: [] };

  const reason = `Automod: ${hit.humanReason}`;
  const key = `${MODULE_ID}:${ctx.guildId}:${facts.messageId}`;

  if (deletesAt(config, hit.severity)) {
    const result = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'delete_message',
      actorId: MODULE_ID,
      reason,
      idempotencyKey: `${key}:delete`,
      dryRun: false,
      // The message is gone either way; a case row per deleted spam message would bury the
      // ledger that moderators actually read.
      record: false,
      payload: { channelId: facts.channelId, messageId: facts.messageId },
    });

    const detail = failure(result);
    if (detail) outcome.failures.push(`could not delete the message: ${detail}`);
    else outcome.deleted = true;
  }

  const response = responseFor(config, hit.severity);
  if (response === 'none') return outcome;

  const kind: ActionKind = response;
  const payload: Record<string, unknown> =
    response === 'timeout'
      ? {
          userId: facts.authorId,
          until: new Date(input.now + timeoutMs(input.settings, hit.severity)),
        }
      : { userId: facts.authorId };

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,
    actorId: MODULE_ID,
    targetId: facts.authorId,
    reason,
    idempotencyKey: `${key}:action`,
    dryRun: false,
    payload,
  });

  const detail = failure(result);
  if (detail) {
    outcome.failures.push(`could not ${response} <@${facts.authorId}>: ${detail}`);
    return outcome;
  }

  outcome.action = kind;

  /**
   * Escalation, and the reason it is published here rather than left to the `warn` action.
   *
   * The `warn` kind is ledger-only and publishes nothing — only `/warn` does, through its own
   * `onRecorded` hook. So automod publishes for itself, on every offence rather than only when
   * the immediate response was `warn`: a guild that sets every severity to `timeout` would
   * otherwise never escalate at all, which is the requirement failing quietly.
   *
   * Not after a kick or a ban. The member is gone, and a ladder rung fired at somebody who is no
   * longer in the guild is noise in the case history.
   */
  if (kind !== 'kick' && kind !== 'ban') {
    try {
      await ctx.publish?.('moderation.warned', `${key}:warn`, {
        userId: facts.authorId,
        channelId: facts.channelId,
      });
    } catch (error) {
      ctx.logger.error(
        `automod could not publish the offence for escalation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      outcome.failures.push(
        'the offence was recorded, but it will not count toward escalation — something went ' +
          'wrong passing it on',
      );
    }
  }

  return outcome;
}
