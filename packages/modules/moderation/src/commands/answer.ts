import type { CommandContext, RespondTo } from '@proton/core';
import { InteractionType } from 'discord-api-types/v10';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { deferTo, respondTo, send, statusMessage } from '../interactions/respond.ts';
import { type Answer, repliesPrivately } from '../perform.ts';
import { type Channel, followChannel, replyChannel } from '../punish/pending.ts';

type Ctx = CommandContext<ModerationConfig>;

export function commandTo(ctx: Ctx): RespondTo {
  return respondTo(
    ctx.guildId,
    ctx.userId,
    {
      id: ctx.interaction.id,
      token: ctx.interaction.token,
      type: InteractionType.ApplicationCommand,
    },
    ctx.idempotencyKey,
  );
}

export async function begin(
  ctx: Ctx,
  deps: Pick<ModerationDeps, 'applicationId'>,
): Promise<Channel> {
  const to = commandTo(ctx);
  const applicationId = ctx.applicationId ?? deps.applicationId;
  if (!applicationId) return replyChannel(ctx, to);

  const ephemeral = repliesPrivately(ctx);
  await send(ctx, deferTo(to, ephemeral));
  return followChannel(ctx, to, applicationId, !ephemeral);
}

export async function acknowledge(
  ctx: Ctx,
  deps: Pick<ModerationDeps, 'applicationId'>,
): Promise<Answer> {
  const channel = await begin(ctx, deps);
  return (body) => channel.say(statusMessage(body), 'result', repliesPrivately(ctx));
}
