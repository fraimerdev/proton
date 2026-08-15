import { dryRunFor, type ModuleContext } from '@proton/core';
import { type LevelingConfig, renderLevelUpMessage } from './config.ts';
import { LEVELING_ACTOR, MODULE_ID } from './perform.ts';
import { planRoleRewards } from './rewards.ts';

/** Where the XP that caused the level-up came from. Reported in the event payload. */
export type LevelUpSource = 'message' | 'voice' | 'admin';

export interface LevelUp {
  userId: string;
  previousLevel: number;
  level: number;
  xp: number;
  source: LevelUpSource;
  /**
   * The idempotency root — always derived from the originating event id, so
   * every action a redelivered event produces reuses the key its first delivery
   * claimed and the executor discards the duplicate (I4).
   */
  idempotencyRoot: string;
  /**
   * Where to announce, when the guild has not named a channel and there is a
   * natural one. A voice level-up has none.
   */
  originChannelId?: string | undefined;
  /** The member's roles, when the dispatch carried them. See `RewardPlanInput`. */
  heldRoleIds?: readonly string[] | undefined;
}

/**
 * Everything that happens when a member crosses into a new level.
 *
 * Three effects, deliberately independent: the event, the reward roles, and the
 * message. Each is attempted whatever the others did, because they fail for
 * unrelated reasons — a missing MANAGE_ROLES must not swallow the announcement,
 * and a channel the bot cannot post in must not cost the member their role. Each
 * failure is logged with the executor's own `humanReason`, verbatim, since it
 * already names the permission and where it is missing (I8) and paraphrasing
 * would throw that away.
 *
 * Only ever called on an *increase*. A level going down — an admin correcting a
 * number with `/xp take` — grants nothing and, importantly, revokes nothing:
 * Proton stripping roles in bulk because a moderator fixed a typo is exactly the
 * failure mode §15 warns about, and the guild can remove a role by hand far more
 * cheaply than it can undo a mass revoke.
 */
export async function applyLevelUp(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
): Promise<void> {
  if (levelUp.level <= levelUp.previousLevel) return;

  await publishLevelGained(ctx, levelUp);
  await applyRewards(ctx, levelUp);
  await announce(ctx, levelUp);
}

/**
 * Tell the rest of Proton (§4-P1's `xp.level_gained`).
 *
 * Published through the manifest's `emits` allowlist rather than over a bus
 * handle, which is what keeps I3 intact: the runtime stamps the guild and
 * derives the event id, so this module cannot publish into another guild or mint
 * an id that defeats dedupe (docs/PHASE-3.md G5).
 *
 * The natural key carries the guild id even though the runtime knows it. If the
 * runtime prefixes its own, the key has a redundant segment and nothing else
 * changes; if it does not, two guilds' level-ups for the same user id would
 * collide and one would be silently discarded. A duplicated segment is harmless,
 * a collision is not.
 *
 * A consequence worth stating: reaching level 5 twice — after an admin took XP
 * away — produces an id already seen, and the second is deduped. That is the
 * right trade. The alternative is an id that changes on every delivery, which
 * would make a redelivered message award a second level-up message, and this
 * event is the one thing a future rule builder will hang actions off.
 */
async function publishLevelGained(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
): Promise<void> {
  if (!ctx.publish) {
    // Not silent: a module whose whole contract with the rest of the system is
    // an event, running somewhere that cannot publish it, is a wiring bug.
    ctx.logger.warn(
      `leveling reached level ${levelUp.level} for ${levelUp.userId} but could not publish ` +
        "xp.level_gained: this module's context has no publish port. Anything reacting to " +
        'level-ups — including the future rule builder — will never see it. The process ' +
        'running modules must supply ModuleContext.publish.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: levelUp.userId },
    );
    return;
  }

  await ctx.publish('xp.level_gained', `${ctx.guildId}:${levelUp.userId}:${levelUp.level}`, {
    guildId: ctx.guildId,
    userId: levelUp.userId,
    level: levelUp.level,
    previousLevel: levelUp.previousLevel,
    xp: levelUp.xp,
    source: levelUp.source,
  });
}

async function applyRewards(ctx: ModuleContext<LevelingConfig>, levelUp: LevelUp): Promise<void> {
  const plan = planRoleRewards({
    rewards: ctx.config.roleRewards,
    level: levelUp.level,
    mode: ctx.config.rewardMode,
    heldRoleIds: levelUp.heldRoleIds,
  });

  for (const roleId of plan.grant) {
    await moveRole(ctx, levelUp, 'add_role', roleId);
  }

  for (const roleId of plan.revoke) {
    await moveRole(ctx, levelUp, 'remove_role', roleId);
  }
}

async function moveRole(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
  kind: 'add_role' | 'remove_role',
  roleId: string,
): Promise<void> {
  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,
    targetId: levelUp.userId,
    actorId: LEVELING_ACTOR,
    reason: `Reached level ${levelUp.level}.`,
    payload: { userId: levelUp.userId, roleId },
    dryRun: dryRunFor(kind),
    // The role id is part of the key: one level-up can move several roles, and a
    // shared key would let the first one claim the dedupe slot for all of them.
    idempotencyKey: `${levelUp.idempotencyRoot}:${kind}:${roleId}`,
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `leveling could not ${kind === 'add_role' ? 'grant' : 'remove'} the level ` +
        `${levelUp.level} reward role ${roleId} for ${levelUp.userId}: ` +
        `${result.failure?.humanReason ?? 'no reason was reported'}`,
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: levelUp.userId,
        roleId,
        code: result.failure?.code,
      },
    );
  }
}

/**
 * Post the level-up message, if the guild wants one and there is somewhere to
 * put it.
 *
 * An empty template is a guild choosing silence, not a misconfiguration, so it
 * is not logged. A voice level-up with no configured channel *is* logged once at
 * info, because "I levelled up in voice and nothing happened" is otherwise
 * indistinguishable from the feature being broken.
 */
async function announce(ctx: ModuleContext<LevelingConfig>, levelUp: LevelUp): Promise<void> {
  const template = ctx.config.levelUpMessage.trim();
  if (template.length === 0) return;

  const channelId = ctx.config.levelUpChannelId ?? levelUp.originChannelId;
  if (!channelId) {
    ctx.logger.info(
      `${levelUp.userId} reached level ${levelUp.level} in voice, but this server has no ` +
        'level-up channel configured and a voice level-up has no channel of its own, so ' +
        'nothing was posted.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: levelUp.userId },
    );
    return;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: LEVELING_ACTOR,
    idempotencyKey: `${levelUp.idempotencyRoot}:level-up`,
    dryRun: false,
    payload: {
      channelId,
      content: renderLevelUpMessage(template, {
        userId: levelUp.userId,
        level: levelUp.level,
        xp: levelUp.xp,
      }).slice(0, 2000),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `leveling could not post the level-up message: ${
        result.failure?.humanReason ?? 'no reason was reported'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId, code: result.failure?.code },
    );
  }
}
