import type { CommandContext } from '@proton/core';
import type { LevelingConfig } from './config.ts';

export const MODULE_ID = 'leveling';

/**
 * `ActionRequest.actorId` for anything leveling did on its own.
 *
 * Not a snowflake, for the same reason as `RULE_ENGINE_ACTOR` and
 * `ANTIRAID_ACTOR`: nobody pressed a button. Attributing a reward role to the
 * admin who once configured it would read in the case ledger as that person
 * having handed it out by hand. `/xp` is different — a moderator really did do
 * that, so those actions carry their id.
 */
export const LEVELING_ACTOR = 'proton:leveling';

/**
 * Acknowledge an interaction.
 *
 * Through the executor like every other state change (I1), and never
 * conditional: a handler that returns silently leaves Discord showing "This
 * interaction failed", which is indistinguishable from a crash and teaches the
 * invoker nothing (§1, I9).
 *
 * Answered immediately rather than deferred. I9 asks for a deferral when a
 * handler touches the database or REST before it can answer, and these handlers
 * do — but each one runs a single indexed read and then replies, which is inside
 * the 3-second window by orders of magnitude. Deferring would mean a second
 * action kind (`interaction_followup`) whose payload needs the *application* id,
 * and `ModuleContext` carries no such thing; taking that path would mean
 * threading the application id through the module for no gain. If a leaderboard
 * page ever grows expensive enough to be a real risk, that is the moment to
 * revisit it — with a measurement, not a hunch.
 */
export async function reply(
  ctx: CommandContext<LevelingConfig>,
  content: string,
  options: { ephemeral?: boolean } = {},
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'interaction_reply',
    actorId: ctx.userId,
    // Derived from the event id, so a redelivered interaction reuses the key and
    // the executor discards the second attempt (I4).
    idempotencyKey: `${ctx.idempotencyKey}:reply`,
    // Never dry-run: I12 withholds destructive effects, not explanations.
    dryRun: false,
    payload: {
      interactionId: ctx.interaction.id,
      interactionToken: ctx.interaction.token,
      // Discord rejects a body over 2000 characters outright, which would turn a
      // long leaderboard into no reply at all.
      content: content.slice(0, 2000),
      ephemeral: options.ephemeral ?? false,
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    // Nothing left to reply *with* — the log is the only channel remaining.
    ctx.logger.warn(
      `leveling could not answer the invoker: ${result.failure?.humanReason ?? 'unknown reason'}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
    );
  }
}
