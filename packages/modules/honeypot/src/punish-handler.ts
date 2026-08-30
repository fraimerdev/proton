import type { ModuleContext, ScheduledHandler } from '@proton/core';
import { type HoneypotConfig, MODULE_ID } from './config.ts';
import { bindHoneypotDeps, describeUnbound, type HoneypotDeps } from './deps.ts';
import { spring, type TrapOutcome } from './listener.ts';
import { type PunishData, punishDataSchema } from './punish.ts';

export function createPunishHandler(deps: HoneypotDeps): ScheduledHandler<HoneypotConfig> {
  return async (raw, ctx) => {
    const data = punishDataSchema.safeParse(raw);
    if (!data.success) {
      ctx.logger.error(
        'a honeypot punishment came due carrying data Proton could not read, so nothing was done ' +
          'to the member. This is a Proton bug, not a configuration problem.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    await runPunishment(ctx, deps, data.data);
  };
}

export async function runPunishment(
  ctx: ModuleContext<HoneypotConfig>,
  rawDeps: HoneypotDeps,
  data: PunishData,
): Promise<TrapOutcome> {
  const bound = bindHoneypotDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('a honeypot punishment came due', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: 'the honeypot ports are unbound' };
  }

  // The member may have been dealt with during the wait — by a moderator, or by leaving. The
  // tombstone is what a member.left or a ban writes, and acting now would ban somebody twice or
  // lift a ban a moderator placed themselves.
  if (await rawDeps.pending?.settled(ctx.guildId, data.userId)) {
    ctx.logger.info(
      `${data.userId} was already dealt with while the honeypot was waiting, so nothing was done.`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: data.userId },
    );
    return { action: 'ignored', reason: 'the member was already dealt with' };
  }

  return spring(
    ctx,
    bound.deps,
    rawDeps,
    { channelId: data.channelId, enabled: true },
    {
      messageId: data.messageId,
      channelId: data.channelId,
      authorId: data.userId,
      type: 0,
      isBot: false,
      isWebhook: false,
      content: data.content,
      roleIds: null,
    },
    data.punishment,
  );
}
