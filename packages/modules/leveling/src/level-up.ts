import {
  type AllowedMentions,
  type MessageTemplate,
  type ModuleContext,
  renderTemplate,
  toDiscordMessage,
} from '@proton/core';
import { levelUpCustomId } from './component-id.ts';
import { isSilentLevelUp, type LevelingConfig, type LevelUpMessage } from './config.ts';
import { LEVELING_ACTOR, MODULE_ID } from './perform.ts';
import { planRoleRewards } from './rewards.ts';

export type LevelUpSource = 'message' | 'voice' | 'admin';

export interface LevelUpValues {
  userId: string;
  level: number;
  xp: number;
}

export type LevelUpBody = MessageTemplate & { allowedMentions: AllowedMentions };

export type LevelUpRender = { ok: true; body: LevelUpBody } | { ok: false; humanReason: string };

export function renderLevelUpMessage(
  message: LevelUpMessage,
  values: LevelUpValues,
  now?: Date,
): LevelUpRender {
  const { allowedMentions, ...body } = toDiscordMessage(message, {
    customIdFor: levelUpCustomId,
    ...(now ? { now } : {}),
  });

  const rendered = renderTemplate(body as unknown as MessageTemplate, {
    user: `<@${values.userId}>`,
    level: values.level,
    xp: values.xp,
  });

  return rendered.ok
    ? { ok: true, body: { ...rendered.template, allowedMentions } }
    : { ok: false, humanReason: rendered.humanReason };
}

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
    dryRun: false,

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
  const message = ctx.config.levelUpMessage;
  if (isSilentLevelUp(message)) return;

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

  const rendered = renderLevelUpMessage(message, {
    userId: levelUp.userId,
    level: levelUp.level,
    xp: levelUp.xp,
  });

  if (!rendered.ok) {
    ctx.logger.warn(
      `leveling could not build the level-up message for ${levelUp.userId}: ` +
        `${rendered.humanReason} Fix it under Level-up announcement on the Leveling page of the ` +
        'Proton dashboard.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, channelId, userId: levelUp.userId },
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
    payload: { channelId, ...rendered.body },
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
