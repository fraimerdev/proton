import type { ActionResult, ModuleContext } from '@proton/core';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';

export const REPORTS_ACTOR = 'proton:reports';

export type DirectOutcome = 'sent' | 'closed' | 'no_mutual_server' | 'failed';

const DMS_CLOSED = 50007;
const NO_MUTUAL_SERVER = 50278;

export interface DirectMessage {
  content?: string;
  embeds?: Record<string, unknown>[];
  components?: Record<string, unknown>[];
}

export interface DirectInput {
  userId: string;
  root: string;
  message: DirectMessage;
}

function idOf(result: ActionResult): string | null {
  const id = (result.body as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

export function undelivered(result: ActionResult): Exclude<DirectOutcome, 'sent'> {
  const code = result.failure?.discordCode;
  if (code === NO_MUTUAL_SERVER) return 'no_mutual_server';
  if (code === DMS_CLOSED || result.failure?.code === 'discord_403') return 'closed';
  return 'failed';
}

export async function sendDirect(
  ctx: ModuleContext<ModerationConfig>,
  deps: ModerationDeps,
  input: DirectInput,
): Promise<DirectOutcome> {
  const context = { guildId: ctx.guildId, moduleId: MODULE_ID, userId: input.userId };
  let channelId = (await deps.dmChannels?.recall(ctx.guildId, input.userId)) ?? null;

  if (channelId === null) {
    const opened = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: REPORTS_ACTOR,
      targetId: input.userId,
      idempotencyKey: `${input.root}:dm:open`,
      dryRun: false,
      record: false,
      payload: { userId: input.userId },
    });

    channelId = idOf(opened);

    if (channelId === null) {
      if (opened.status === 'skipped_duplicate') {
        ctx.logger.warn(
          `a direct message to ${input.userId} was opened by an earlier attempt whose channel id ` +
            'was not kept, so this attempt could not send it.',
          context,
        );
        return 'failed';
      }

      return undelivered(opened);
    }

    await deps.dmChannels?.remember(ctx.guildId, input.userId, channelId);
  }

  const sent = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: REPORTS_ACTOR,
    targetId: input.userId,
    idempotencyKey: `${input.root}:dm:send`,
    dryRun: false,
    record: false,
    payload: { channelId, ...input.message, allowedMentions: { parse: [] }, directMessage: true },
  });

  if (sent.status === 'executed' || sent.status === 'skipped_duplicate') return 'sent';

  return undelivered(sent);
}
