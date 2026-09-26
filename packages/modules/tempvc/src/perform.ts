import {
  type ActionResult,
  type CommandContext,
  deferEphemeral,
  errorStatus,
  followUp,
  type RespondTo,
  type StatusBody,
  successStatus,
} from '@proton/core';
import { InteractionType } from 'discord-api-types/v10';
import { MODULE_ID, type TempVcConfig } from './config.ts';
import type { DisconnectOutcome } from './service.ts';

const LEFT_VOICE = new Set(['discord_400', 'discord_404']);

function notDisconnected(target: string, code: string | undefined): string {
  switch (code) {
    case 'missing_permission':
      return (
        `Couldn’t disconnect <@${target}> because I’m missing Move Members in this server. ` +
        'Ask an admin to give it to me.'
      );
    case 'discord_403':
      return (
        `Discord wouldn’t let me disconnect <@${target}>. I’m probably missing Move Members in ` +
        'this server, so ask an admin to check.'
      );
    case 'discord_404':
      return `<@${target}> has left this server, so there was no one to disconnect.`;
    case 'discord_400':
      return `<@${target}> has left voice, so there was no one to disconnect.`;
    default:
      return (
        `Couldn’t confirm that <@${target}> was disconnected. Check the channel before trying ` +
        'again.'
      );
  }
}

export function disconnectAnswer(outcome: DisconnectOutcome, target: string): StatusBody {
  if (outcome === 'disconnected') {
    return successStatus(`Disconnected <@${target}> from your channel.`);
  }

  if (outcome === 'not_in_channel') {
    return errorStatus(`I can’t see <@${target}> in your channel, so I didn’t disconnect them.`);
  }

  return errorStatus(notDisconnected(target, outcome.failed));
}

export function blockAnswer(disconnect: DisconnectOutcome | null, target: string): StatusBody {
  const blocked = `Blocked <@${target}> from your channel.`;

  if (
    disconnect === null ||
    typeof disconnect === 'string' ||
    LEFT_VOICE.has(disconnect.failed ?? '')
  ) {
    return successStatus(blocked);
  }

  return errorStatus(`${blocked} ${notDisconnected(target, disconnect.failed)}`);
}

type Ctx = CommandContext<TempVcConfig>;

export type Answer = (message: string | StatusBody) => Promise<void>;

function bodyOf(message: string | StatusBody): { content: string } | StatusBody {
  return typeof message === 'string' ? { content: message.slice(0, 2000) } : message;
}

function warnUnanswered(ctx: Ctx, result: ActionResult): void {
  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `tempvc could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}

export async function reply(
  ctx: Ctx,
  message: string | StatusBody,
  suffix = 'reply',
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    idempotencyKey: `${ctx.idempotencyKey}:${suffix}`,
    dryRun: false,
    record: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      ...bodyOf(message),
      ephemeral: true,
    },
  });

  warnUnanswered(ctx, result);
}

function commandTo(ctx: Ctx): RespondTo {
  return {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: ctx.userId,
    interaction: {
      id: ctx.interaction.id,
      token: ctx.interaction.token,
      type: InteractionType.ApplicationCommand,
    },
    idempotencyKey: ctx.idempotencyKey,
  };
}

export async function acknowledge(ctx: Ctx): Promise<Answer> {
  const applicationId = ctx.applicationId;
  // Without an application id there is no followup webhook, so the one callback must be the answer.
  if (!applicationId) return (message) => reply(ctx, message);

  const to = commandTo(ctx);
  warnUnanswered(
    ctx,
    await ctx.executor.execute(
      deferEphemeral({ ...to, idempotencyKey: `${ctx.idempotencyKey}:defer` }),
    ),
  );

  return async (message) =>
    warnUnanswered(
      ctx,
      await ctx.executor.execute(
        followUp({ ...to, applicationId }, { ...bodyOf(message), ephemeral: true }),
      ),
    );
}
