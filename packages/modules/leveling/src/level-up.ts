import {
  type DiscordMessageBody,
  type GuildState,
  type ModuleContext,
  toDiscordMessage,
} from '@proton/core';
import {
  type BotFacts,
  type ChannelFacts,
  collectMessageSites,
  type MemberFacts,
  type PathDiagnostic,
  PROTON_SUPPORT_URL,
  renderMessageTemplate,
  serverFactsFrom,
  type UserFacts,
  usedKeys,
} from '@proton/core/placeholders';
import { levelUpCustomId } from './component-id.ts';
import { isSilentLevelUp, type LevelingConfig, type LevelUpMessage } from './config.ts';
import type { LevelingDeps } from './deps.ts';
import { LEVELING_ACTOR, MODULE_ID } from './perform.ts';
import {
  LEVEL_UP_BASE_PATH,
  LEVEL_UP_RANK_KEYS,
  LEVEL_UP_RANKED_COUNT_KEY,
  LEVEL_UP_SURFACE,
  type LevelUpPlaceholderFacts,
  type LevelUpRank,
} from './placeholders.ts';
import { planRoleRewards, type RewardPlan } from './rewards.ts';

export type LevelUpSource = 'message' | 'voice' | 'admin';

export type LevelUpBody = DiscordMessageBody;

export type LevelUpRender =
  | { ok: true; body: LevelUpBody; diagnostics: PathDiagnostic[] }
  | { ok: false; humanReason: string; diagnostics: PathDiagnostic[] };

export type LevelingRenderDeps = Pick<LevelingDeps, 'xp' | 'guildState' | 'placeholders' | 'now'>;

export function renderLevelUpMessage(
  message: LevelUpMessage,
  facts: LevelUpPlaceholderFacts,
  now: number,
): LevelUpRender {
  const rendered = renderMessageTemplate(
    message,
    LEVEL_UP_SURFACE,
    LEVEL_UP_SURFACE.build(facts, { now }),
    { now, basePath: LEVEL_UP_BASE_PATH },
  );

  if (!rendered.ok) {
    return { ok: false, humanReason: rendered.humanReason, diagnostics: rendered.diagnostics };
  }

  const body = toDiscordMessage(rendered.message, {
    customIdFor: levelUpCustomId,
    now: new Date(now),
  });

  return { ok: true, body, diagnostics: rendered.diagnostics };
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

  gained?: number | undefined;

  user?: UserFacts | undefined;

  member?: MemberFacts | undefined;
}

export async function applyLevelUp(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
  deps: LevelingRenderDeps = {},
): Promise<void> {
  if (levelUp.level <= levelUp.previousLevel) return;

  await publishLevelGained(ctx, levelUp);
  const plan = await applyRewards(ctx, levelUp);
  await announce(ctx, levelUp, plan, deps);
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

async function applyRewards(
  ctx: ModuleContext<LevelingConfig>,
  levelUp: LevelUp,
): Promise<RewardPlan> {
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

  return plan;
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

const PROFILE_KEYS: ReadonlySet<string> = new Set([
  'user.username',
  'user.global_name',
  'user.display_name',
  'user.avatar_url',
  'user.is_bot',
]);

const GUILD_NAMESPACES = ['server.', 'channel.', 'destination_channel.'];

interface LevelUpNeeds {
  keys: ReadonlySet<string>;
  profile: boolean;
}

function needsOf(message: LevelUpMessage): LevelUpNeeds {
  const keys = new Set<string>();
  let profile = false;

  for (const site of collectMessageSites(message, '')) {
    for (const key of usedKeys(LEVEL_UP_SURFACE, [site.text], { allowedOnly: true })) {
      keys.add(key);
      if (PROFILE_KEYS.has(key) || (key === 'user.mention' && site.spec.kind !== 'discord_text')) {
        profile = true;
      }
    }
  }

  return { keys, profile };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function channelFactsOf(state: GuildState | null, channelId: string): ChannelFacts {
  const known = state?.channels.get(channelId);
  if (known === undefined) return { id: channelId };

  return { id: channelId, name: known.name, type: known.type, parentId: known.parentId };
}

type Context = ModuleContext<LevelingConfig>;

async function userFactsFor(
  ctx: Context,
  levelUp: LevelUp,
  needs: LevelUpNeeds,
  deps: LevelingRenderDeps,
): Promise<UserFacts | null> {
  if (levelUp.user !== undefined) return levelUp.user;

  const unread: UserFacts = {
    id: levelUp.userId,
    username: null,
    globalName: null,
    avatarHash: null,
  };
  if (!needs.profile || deps.placeholders === undefined) return unread;

  try {
    return await deps.placeholders.user(levelUp.userId);
  } catch (error) {
    ctx.logger.warn(
      `leveling could not read the profile of ${levelUp.userId}, so their name and avatar ` +
        `render as nothing in the level-up message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: levelUp.userId },
    );
    return null;
  }
}

async function guildStateFor(
  ctx: Context,
  needs: LevelUpNeeds,
  deps: LevelingRenderDeps,
): Promise<GuildState | null> {
  const wanted = [...needs.keys].some((key) =>
    GUILD_NAMESPACES.some((namespace) => key.startsWith(namespace)),
  );
  if (!wanted || deps.guildState === undefined) return null;

  try {
    return await deps.guildState.get(ctx.guildId);
  } catch (error) {
    ctx.logger.warn(
      'leveling could not read the guild-state cache, so server and channel details render as ' +
        `nothing in the level-up message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

async function rankFor(
  ctx: Context,
  levelUp: LevelUp,
  needs: LevelUpNeeds,
  deps: LevelingRenderDeps,
): Promise<LevelUpRank | null | undefined> {
  if (deps.xp === undefined || !LEVEL_UP_RANK_KEYS.some((key) => needs.keys.has(key))) {
    return undefined;
  }

  try {
    const record = await deps.xp.get(ctx.guildId, levelUp.userId);
    if (record !== null) {
      return {
        rank: record.rank,
        messages: record.messageCount,
        voiceSeconds: record.voiceSeconds,
      };
    }
    ctx.logger.warn(
      `leveling found no XP record for ${levelUp.userId} just after they levelled up, so their ` +
        'rank renders as nothing in the level-up message.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: levelUp.userId },
    );
  } catch (error) {
    ctx.logger.warn(
      `leveling could not read the rank of ${levelUp.userId}, so it renders as nothing in the ` +
        `level-up message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: levelUp.userId },
    );
  }

  return null;
}

async function rankedCountFor(
  ctx: Context,
  needs: LevelUpNeeds,
  deps: LevelingRenderDeps,
): Promise<number | null | undefined> {
  if (deps.xp === undefined || !needs.keys.has(LEVEL_UP_RANKED_COUNT_KEY)) return undefined;

  try {
    return await deps.xp.countRanked(ctx.guildId);
  } catch (error) {
    ctx.logger.warn(
      'leveling could not count the ranked members, so that count renders as nothing in the ' +
        `level-up message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

async function botFactsFor(
  ctx: Context,
  needs: LevelUpNeeds,
  deps: LevelingRenderDeps,
): Promise<BotFacts | null> {
  const wanted = [...needs.keys].some((key) => key.startsWith('bot.'));
  if (!wanted || deps.placeholders === undefined) return null;

  try {
    return await deps.placeholders.bot();
  } catch (error) {
    ctx.logger.warn(
      'Proton could not read its own profile, so its name and avatar render as nothing in the ' +
        `level-up message: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { id: deps.placeholders.applicationId, name: null, supportUrl: PROTON_SUPPORT_URL };
  }
}

async function factsFor(
  ctx: Context,
  levelUp: LevelUp,
  plan: RewardPlan,
  channelId: string,
  deps: LevelingRenderDeps,
): Promise<LevelUpPlaceholderFacts> {
  const needs = needsOf(ctx.config.levelUpMessage);
  const state = await guildStateFor(ctx, needs, deps);

  return {
    userId: levelUp.userId,
    user: await userFactsFor(ctx, levelUp, needs, deps),
    member: levelUp.member ?? 'unavailable',
    level: levelUp.level,
    previousLevel: levelUp.previousLevel,
    xp: levelUp.xp,
    gained: levelUp.gained,
    source: levelUp.source,
    rank: await rankFor(ctx, levelUp, needs, deps),
    rankedMemberCount: await rankedCountFor(ctx, needs, deps),
    rewards: { granted: plan.grant, revoked: plan.revoke },
    server: serverFactsFrom(state, ctx.guildId),
    originChannel:
      levelUp.originChannelId === undefined
        ? undefined
        : channelFactsOf(state, levelUp.originChannelId),
    destinationChannel: channelFactsOf(state, channelId),
    bot: await botFactsFor(ctx, needs, deps),
  };
}

async function announce(
  ctx: Context,
  levelUp: LevelUp,
  plan: RewardPlan,
  deps: LevelingRenderDeps,
): Promise<void> {
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

  const now = deps.placeholders?.now() ?? deps.now?.() ?? Date.now();
  const facts = await factsFor(ctx, levelUp, plan, channelId, deps);
  const rendered = renderLevelUpMessage(message, facts, now);

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
