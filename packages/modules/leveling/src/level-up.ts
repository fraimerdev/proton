import { dryRunFor, type ModuleContext } from '@proton/core';
import { type LevelingConfig, renderLevelUpMessage } from './config.ts';
import { LEVELING_ACTOR, MODULE_ID } from './perform.ts';
import { planRoleRewards } from './rewards.ts';

export type LevelUpSource = 'message' | 'voice' | 'admin';

export interface LevelUp {
  userId: string;
  previousLevel: number;
  level: number;
  xp: number;
  source: LevelUpSource;

  idempotencyRoot: string;

  originChannelId?: string | undefined;

  heldRoleIds?: readonly string[] | undefined;
}

export async function applyLevelUp(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
): Promise<void> {
  if (levelUp.level <= levelUp.previousLevel) return;

  await publishLevelGained(ctx, levelUp);
  await applyRewards(ctx, levelUp);
  await announce(ctx, levelUp);
}

async function publishLevelGained(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
): Promise<void> {
  if (!ctx.publish) {
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
