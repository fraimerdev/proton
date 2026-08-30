import type { ModuleContext } from '@proton/core';
import { snowflakeSchema } from '@proton/core';
import { z } from 'zod';
import { type HoneypotConfig, MODULE_ID, WAIT_SECONDS_MAX } from './config.ts';
import { punishmentSchema } from './plan.ts';

export const PUNISH_JOB = 'punish';

export const punishDataSchema = z.object({
  channelId: snowflakeSchema,
  messageId: snowflakeSchema,
  userId: snowflakeSchema,

  content: z.string().default(''),
  caughtAt: z.number().int().nonnegative(),

  punishment: punishmentSchema,
});

export type PunishData = z.infer<typeof punishDataSchema>;

export type WaitOutcome =
  | { action: 'waiting'; runAt: number }
  | { action: 'unscheduled'; reason: string };

/**
 * Keyed on the member, not the message. The burst lock lets go after a minute and the wait can be
 * seven days, so a bot posting every couple of minutes would otherwise park one pending punishment
 * per message. `replace: false` keeps the first one: replacing would let it push its own
 * punishment out for as long as it kept posting.
 */
export async function schedulePunishment(
  ctx: ModuleContext<HoneypotConfig>,
  data: PunishData,
  delaySeconds: number,
): Promise<WaitOutcome> {
  if (!ctx.schedule) {
    ctx.logger.error(
      `${data.userId} tripped a honeypot and this server asks Proton to wait before acting, but ` +
        'this deployment has no durable scheduler wired into the module runtime, so nothing was ' +
        'booked and nothing will happen to them. Set the wait to zero, or wire the scheduler.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: data.userId },
    );

    return { action: 'unscheduled', reason: 'this deployment has no durable scheduler' };
  }

  const seconds = Math.min(WAIT_SECONDS_MAX, Math.max(0, delaySeconds));
  const runAt = data.caughtAt + seconds * 1000;

  await ctx.schedule(PUNISH_JOB, new Date(runAt), data.userId, data, { replace: false });

  ctx.logger.info(`${data.userId} tripped a honeypot; Proton will act in ${seconds} seconds.`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    userId: data.userId,
  });

  return { action: 'waiting', runAt };
}
