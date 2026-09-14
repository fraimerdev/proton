import type { ModuleContext } from '@proton/core';
import { z } from 'zod';
import { type AfkConfig, MODULE_ID } from './config.ts';
import { type AfkDeps, bindStore, describeUnbound } from './deps.ts';
import { nicknameProblem } from './render.ts';
import { discardEnded, endSession, failureOf } from './session.ts';

export const expireDataSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
});

export const tidyDataSchema = z.object({
  channelId: z.string().min(1),
  messageId: z.string().min(1),
});

function unreadable(ctx: ModuleContext<AfkConfig>, what: string, error: z.ZodError): void {
  ctx.logger.error(
    `a scheduled AFK ${what} carried data this build cannot read (${error.issues
      .map((issue) => `${issue.path.map(String).join('.')} ${issue.message}`)
      .join('; ')}), so it was dropped. The row was written by a different build of this module.`,
    { guildId: ctx.guildId, moduleId: MODULE_ID },
  );
}

export async function expireAfk(
  data: unknown,
  ctx: ModuleContext<AfkConfig>,
  deps: AfkDeps,
): Promise<void> {
  const parsed = expireDataSchema.safeParse(data);
  if (!parsed.success) return unreadable(ctx, 'expiry', parsed.error);

  const bound = bindStore(deps);
  if ('unbound' in bound) {
    throw new Error(describeUnbound('an AFK expiry could not be read', bound.unbound));
  }

  const status = await bound.store.get(ctx.guildId, parsed.data.userId);
  if (!status || status.sessionId !== parsed.data.sessionId) return;

  const nick =
    status.endedAt === null
      ? (
          await endSession(ctx, bound.store, status, {
            endedBy: `expire:${status.sessionId}`,
            actorId: MODULE_ID,
            currentNick: undefined,
            recap: false,
            finish: 'delete',
          })
        )?.nick
      : await discardEnded(ctx, bound.store, status, MODULE_ID);

  if (nick?.status !== 'failed') return;

  ctx.logger.warn(
    `AFK expired ${status.userId}'s status but could not restore their nickname: ${nicknameProblem(nick.failure, 'their')}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId: status.userId },
  );
}

export async function tidyReply(data: unknown, ctx: ModuleContext<AfkConfig>): Promise<void> {
  const parsed = tidyDataSchema.safeParse(data);
  if (!parsed.success) return unreadable(ctx, 'tidy-up', parsed.error);

  const { channelId, messageId } = parsed.data;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'delete_message',
    actorId: MODULE_ID,
    reason: 'Tidying up an AFK reply',
    idempotencyKey: `afk:${ctx.guildId}:tidy:${messageId}`,
    dryRun: false,
    record: false,
    payload: { channelId, messageId },
  });

  if (result.status !== 'failed_precheck' && result.status !== 'failed_api') return;
  if (result.failure?.code === 'discord_404') return;

  const reason = failureOf(result).humanReason;

  if (result.status === 'failed_precheck') {
    ctx.logger.warn(`AFK could not tidy its reply in <#${channelId}>, so it stays: ${reason}`, {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      code: result.failure?.code,
    });
    return;
  }

  throw new Error(`AFK could not delete its reply ${messageId} in <#${channelId}>: ${reason}`);
}
