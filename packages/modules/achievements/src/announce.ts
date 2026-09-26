import {
  type ActionFailure,
  type Attachment,
  type DiscordMessageBody,
  type GuildState,
  isComponentsV2,
  type ModuleContext,
  type TierId,
  tryParseDuration,
} from '@proton/core';
import {
  type BotFacts,
  type ChannelFacts,
  collectMessageSites,
  type MemberFacts,
  PROTON_SUPPORT_URL,
  serverFactsFrom,
  type UserFacts,
  usedKeys,
} from '@proton/core/placeholders';
import { renderBadgePng } from './badge.ts';
import {
  type Achievement,
  type AchievementsConfig,
  type AnnouncementMessage,
  isSilentMessage,
  MODULE_ID,
  type Requirement,
} from './config.ts';
import { ACHIEVEMENTS_ACTOR, MAX_ANNOUNCE_ATTEMPTS, XP_CONFIRM_TIMEOUT_MS } from './constants.ts';
import { type AchievementsDeps, clockOf } from './deps.ts';
import { currentTierIds } from './evaluate.ts';
import {
  ACHIEVEMENT_SURFACES,
  type AchievementMessageKind,
  type AchievementPlaceholderFacts,
  almostThereRoute,
  BADGE_FILENAME,
  EARNED_COUNT_KEY,
  type MessageRoute,
  type RequirementFact,
  type RewardFact,
  type RewardFacts,
  renderAchievementMessage,
  requirementFact,
  toSendBody,
  unlockRoute,
  withBadgeThumbnail,
} from './placeholders.ts';
import { isSettled, isTransientFailure } from './rewards.ts';
import type {
  AchievementStore,
  AnnounceGroup,
  AnnouncementClaim,
  AnnouncementOutcome,
  RewardRow,
  UnlockRow,
} from './store.ts';
import { isTriggerId } from './triggers.ts';
import type { SnapshotRequirement } from './view.ts';

type Context = ModuleContext<AchievementsConfig>;

export const ANNOUNCE_LEASE_MS = 60 * 1000;

export const BADGE_RENDER_BUDGET_MS = 1500;

export const DM_CLOSED = 'They don’t accept DMs from this server.';

const DM_CLOSED_CODES: ReadonlySet<number> = new Set([50007, 50278]);

const FALLBACK_CODES: ReadonlySet<number> = new Set([10003, 50001, 50013]);

const PROFILE_KEYS: ReadonlySet<string> = new Set([
  'user.username',
  'user.global_name',
  'user.display_name',
  'user.avatar_url',
  'user.is_bot',
]);

const MEMBER_KEYS: ReadonlySet<string> = new Set([
  'user.nickname',
  'user.joined_at',
  'user.is_boosting',
  'user.boosting_since',
  'user.role_mentions',
  'user.role_count',
]);

const GUILD_NAMESPACES = ['server.', 'channel.', 'destination_channel.'];

const DAY_MS = 24 * 60 * 60 * 1000;

type Target = { kind: 'channel'; channelId: string } | { kind: 'dm' };

type Plan = { primary: Target; fallback: Target | null } | { skip: string };

type Sent =
  | { status: 'sent'; messageId: string | null }
  | { status: 'duplicate' }
  | { status: 'failed'; failure: ActionFailure }
  | { status: 'unrendered'; reason: string };

const DM: Target = { kind: 'dm' };

function channel(channelId: string): Target {
  return { kind: 'channel', channelId };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function idOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function instant(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function isoAt(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function fallbackTarget(config: AchievementsConfig): Target | null {
  const { fallback, fallbackChannelId } = config.announcement;
  if (fallback === 'dm') return DM;
  if (fallback === 'channel' && fallbackChannelId !== undefined) return channel(fallbackChannelId);
  return null;
}

function unlockPlan(config: AchievementsConfig, route: MessageRoute, origin: string | null): Plan {
  switch (route.destination) {
    case 'dm':
      return { primary: DM, fallback: null };
    case 'none':
      return { skip: 'Unlock announcements are off in this server.' };
    case 'channel':
      return route.channelId === null
        ? { skip: 'No announcement channel is set.' }
        : { primary: channel(route.channelId), fallback: null };
    case 'current': {
      const fallback = fallbackTarget(config);
      if (origin !== null) return { primary: channel(origin), fallback };
      return fallback
        ? { primary: fallback, fallback: null }
        : {
            skip: 'No channel to post in: it was earned outside a channel and no fallback is set.',
          };
    }
  }
}

function canFallBack(failure: ActionFailure): boolean {
  return (
    failure.code === 'missing_permission' ||
    (failure.discordCode !== undefined && FALLBACK_CODES.has(failure.discordCode))
  );
}

interface Needs {
  keys: ReadonlySet<string>;
  profile: boolean;
}

function needsOf(kind: AchievementMessageKind, message: AnnouncementMessage): Needs {
  const keys = new Set<string>();
  let profile = false;

  for (const site of collectMessageSites(message, '')) {
    for (const key of usedKeys(ACHIEVEMENT_SURFACES[kind], [site.text], { allowedOnly: true })) {
      keys.add(key);
      if (PROFILE_KEYS.has(key) || (key === 'user.mention' && site.spec.kind !== 'discord_text')) {
        profile = true;
      }
    }
  }

  return { keys, profile };
}

function channelFactsOf(state: GuildState | null, channelId: string): ChannelFacts {
  const known = state?.channels.get(channelId);
  if (known === undefined) return { id: channelId };
  return { id: channelId, name: known.name, type: known.type, parentId: known.parentId };
}

interface Subject {
  userId: string;
  achievement: AchievementPlaceholderFacts['achievement'];
  tier: TierId;
  tiersUnlocked: readonly TierId[];
  requirements: readonly RequirementFact[];
  rewards: RewardFacts | null;
  unlockedAt: number | null;
  deadline: number | null;
  originChannelId: string | null;
}

interface FactsKit {
  facts: AchievementPlaceholderFacts;
  destination(target: Target): AchievementPlaceholderFacts;
}

async function factsFor(
  ctx: Context,
  deps: AchievementsDeps,
  route: MessageRoute,
  subject: Subject,
): Promise<FactsKit> {
  const needs = needsOf(route.kind, route.message);
  const uses = (prefix: string) => [...needs.keys].some((key) => key.startsWith(prefix));

  let state: GuildState | null = null;
  if (deps.guildState && GUILD_NAMESPACES.some(uses)) {
    try {
      state = await deps.guildState.get(ctx.guildId);
    } catch (error) {
      ctx.logger.warn(
        'achievements could not read the guild-state cache, so server and channel details ' +
          `render as nothing in the announcement: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    }
  }

  let user: UserFacts | null = {
    id: subject.userId,
    username: null,
    globalName: null,
    avatarHash: null,
  };
  if (needs.profile && deps.placeholders) {
    try {
      user = await deps.placeholders.user(subject.userId);
    } catch (error) {
      ctx.logger.warn(
        `achievements could not read the profile of ${subject.userId}, so their name renders as ` +
          `nothing in the announcement: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      user = null;
    }
  }

  let bot: BotFacts | null = null;
  if (deps.placeholders && uses('bot.')) {
    try {
      bot = await deps.placeholders.bot();
    } catch {
      bot = { id: deps.placeholders.applicationId, name: null, supportUrl: PROTON_SUPPORT_URL };
    }
  }

  let earnedCount: number | null = null;
  if (deps.store && needs.keys.has(EARNED_COUNT_KEY)) {
    try {
      earnedCount = await deps.store.earnedCount(ctx.guildId, subject.userId, []);
    } catch {
      earnedCount = null;
    }
  }

  let member: MemberFacts | 'unavailable' = 'unavailable';
  if (deps.memberFacts && [...needs.keys].some((key) => MEMBER_KEYS.has(key))) {
    try {
      const lookup = await deps.memberFacts(ctx.guildId, subject.userId);
      if (lookup !== null) {
        member = {
          // MemberLookup has no nickname yet, so {user.nickname} stays unread, not empty.
          nick: undefined,
          joinedAt: isoAt(lookup.joinedAt),
          premiumSince: isoAt(lookup.premiumSince),
          roleIds: lookup.roleIds,
        };
      }
    } catch (error) {
      ctx.logger.warn(
        `achievements could not read what ${subject.userId} has in this server, so their join ` +
          `date, boost and roles render as nothing in the announcement: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    }
  }

  const facts: AchievementPlaceholderFacts = {
    userId: subject.userId,
    user,
    member,
    server: serverFactsFrom(state, ctx.guildId),
    bot,
    originChannel:
      subject.originChannelId === null ? null : channelFactsOf(state, subject.originChannelId),
    destinationChannel: null,
    achievement: subject.achievement,
    tier: subject.tier,
    tiersUnlocked: subject.tiersUnlocked,
    requirements: subject.requirements,
    rewards: subject.rewards,
    unlockedAt: subject.unlockedAt,
    deadline: subject.deadline,
    earnedCount,
    timeZone: ctx.config.timezone,
  };

  return {
    facts,
    destination: (target) => ({
      ...facts,
      destinationChannel:
        target.kind === 'channel' ? channelFactsOf(state, target.channelId) : null,
    }),
  };
}

async function send(
  ctx: Context,
  target: Target,
  userId: string,
  payload: DiscordMessageBody & { files?: Attachment[] },
  keys: { send: string; open: string },
): Promise<Sent> {
  let channelId: string;

  if (target.kind === 'dm') {
    const opened = await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
      kind: 'create_dm',
      actorId: ACHIEVEMENTS_ACTOR,
      payload: { userId },
      dryRun: false,
      record: false,
      idempotencyKey: keys.open,
    });

    if (opened.status === 'skipped_duplicate') return { status: 'duplicate' };

    const id = idOf(opened.body);
    if (opened.status !== 'executed' || id === null) {
      return {
        status: 'failed',
        failure: opened.failure ?? {
          code: 'dm_unavailable',
          humanReason: 'Discord didn’t open a DM with them.',
        },
      };
    }
    channelId = id;
  } else {
    channelId = target.channelId;
  }

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: ACHIEVEMENTS_ACTOR,
    payload: { ...payload, channelId, ...(target.kind === 'dm' ? { directMessage: true } : {}) },
    dryRun: false,
    record: false,
    idempotencyKey: keys.send,
  });

  if (result.status === 'executed' || result.status === 'dry_run') {
    return { status: 'sent', messageId: idOf(result.body) };
  }
  if (result.status === 'skipped_duplicate') return { status: 'duplicate' };

  return {
    status: 'failed',
    failure: result.failure ?? {
      code: 'unknown',
      humanReason: 'Discord refused the message without saying why.',
    },
  };
}

function outcomeOf(sent: Sent, attempt: number, now: number): AnnouncementOutcome | null {
  switch (sent.status) {
    case 'sent':
      return { status: 'sent', messageId: sent.messageId, now };
    case 'duplicate':
      return null;
    case 'unrendered':
      return { status: 'failed', error: sent.reason, now };
    case 'failed': {
      const { failure } = sent;
      if (failure.discordCode !== undefined && DM_CLOSED_CODES.has(failure.discordCode)) {
        return { status: 'failed', error: DM_CLOSED, now };
      }
      if (isTransientFailure(failure) && attempt < MAX_ANNOUNCE_ATTEMPTS) {
        return { status: 'pending', error: failure.humanReason, now };
      }
      return { status: 'failed', error: failure.humanReason, now };
    }
  }
}

function snapshotRequirement(requirement: SnapshotRequirement): Requirement | null {
  if (!isTriggerId(requirement.trigger)) return null;

  return {
    id: requirement.id,
    version: requirement.version,
    trigger: requirement.trigger,
    channelIds: requirement.channelIds,
    excludedChannelIds: requirement.excludedChannelIds,
    ...(requirement.xpSources === undefined ? {} : { xpSources: requirement.xpSources }),
    ...(requirement.achievementId === undefined
      ? {}
      : { achievementId: requirement.achievementId }),
    ...(requirement.tierId === undefined ? {} : { tierId: requirement.tierId }),
  };
}

function nameLookup(config: AchievementsConfig): (id: string) => string | undefined {
  return (id) => config.achievements.find((candidate) => candidate.id === id)?.name;
}

function rewardFactsOf(rewards: readonly RewardRow[], tiers: ReadonlySet<TierId>): RewardFacts {
  const granted: RewardFact[] = [];
  const pending: RewardFact[] = [];
  const failed: RewardFact[] = [];

  for (const row of rewards) {
    if (!tiers.has(row.tierId)) continue;

    const fact: RewardFact =
      row.kind === 'xp'
        ? { kind: 'xp', amount: row.amount ?? 0 }
        : { kind: row.kind, ...(row.roleId === null ? {} : { roleId: row.roleId }) };

    if (row.status === 'delivered') granted.push(fact);
    else if (row.status === 'failed' && !row.transient) failed.push(fact);
    else if (!isSettled(row)) pending.push(fact);
  }

  return { granted, pending, failed };
}

function achievementFacts(
  achievement: Achievement | null,
  top: UnlockRow,
): AchievementPlaceholderFacts['achievement'] {
  return {
    id: top.achievementId,
    name: achievement?.name ?? top.definition.name,
    description: achievement?.description ?? '',
    kind: achievement?.kind ?? top.definition.kind,
    tierCount: achievement?.tiers.length ?? 1,
  };
}

async function deliverAnnouncement(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  claim: AnnouncementClaim,
  now: number,
): Promise<AnnouncementOutcome | null> {
  const top = claim.rows.at(-1);
  if (!top) return null;

  const config = ctx.config;
  const achievement = config.achievements.find(({ id }) => id === top.achievementId) ?? null;
  const route = unlockRoute(config, achievement);
  if (route === null) {
    return { status: 'skipped', error: 'Announcements are off for this achievement.', now };
  }
  if (isSilentMessage(route.message)) {
    return { status: 'skipped', error: 'The announcement message is empty.', now };
  }

  const origin = claim.rows.map((row) => row.originChannelId).find((id) => id !== null) ?? null;
  const plan = unlockPlan(config, route, origin);
  if ('skip' in plan) return { status: 'skipped', error: plan.skip, now };

  const [held, rewards] = await Promise.all([
    store.unlocksOf(ctx.guildId, top.userId),
    store.rewardsFor(ctx.guildId, top.userId, top.achievementId, top.generation),
  ]);

  const tiersUnlocked = held
    .filter((row) => row.achievementId === top.achievementId && row.generation === top.generation)
    .map((row) => row.tierId);

  const nameOf = nameLookup(config);
  const requirements = top.definition.requirements.flatMap((snapshot) => {
    const requirement = snapshotRequirement(snapshot);
    return requirement === null
      ? []
      : [
          requirementFact(
            requirement,
            snapshot.target,
            top.progress[snapshot.id] ?? snapshot.target,
            nameOf,
          ),
        ];
  });

  const kit = await factsFor(ctx, deps, route, {
    userId: top.userId,
    achievement: achievementFacts(achievement, top),
    tier: top.tierId,
    tiersUnlocked: tiersUnlocked.length > 0 ? tiersUnlocked : claim.rows.map((row) => row.tierId),
    requirements,
    rewards: rewardFactsOf(rewards, new Set(claim.rows.map((row) => row.tierId))),
    unlockedAt: top.unlockedAt,
    deadline: instant(achievement?.endsAt),
    originChannelId: origin,
  });

  let badge: Promise<Uint8Array | null> | undefined;
  const badgeImage = (): Promise<Uint8Array | null> => {
    if (achievement === null) return Promise.resolve(null);
    badge ??= renderBadgePng(deps, ctx.guildId, achievement, top.tierId, BADGE_RENDER_BUDGET_MS);
    return badge;
  };

  const root = `achievements:${ctx.guildId}:announce:${top.announceGroup}`;

  const attempt = async (target: Target, suffix: string): Promise<Sent> => {
    const rendered = renderAchievementMessage(
      route.kind,
      route.message,
      kit.destination(target),
      now,
      route.basePath,
    );
    if (!rendered.ok) return { status: 'unrendered', reason: rendered.humanReason };

    let message = rendered.message;
    const files: Attachment[] = [];

    if (config.announcement.attachBadge && !isComponentsV2(message)) {
      const png = await badgeImage();
      if (png) {
        files.push({
          filename: BADGE_FILENAME,
          contentType: 'image/png',
          data: new Uint8Array(png),
        });
        message = withBadgeThumbnail(message);
      }
    }

    let body: DiscordMessageBody;
    try {
      body = toSendBody(target.kind === 'dm' ? 'unlocked_dm' : 'unlocked', message, now);
    } catch (error) {
      return { status: 'unrendered', reason: reasonOf(error) };
    }

    return send(
      ctx,
      target,
      top.userId,
      { ...body, ...(files.length > 0 ? { files } : {}) },
      { send: `${root}:${claim.attempt}${suffix}`, open: `${root}:dm-open:${claim.attempt}` },
    );
  };

  const first = await attempt(plan.primary, '');
  if (first.status === 'failed' && plan.fallback !== null && canFallBack(first.failure)) {
    return outcomeOf(await attempt(plan.fallback, ':fallback'), claim.attempt, now);
  }

  return outcomeOf(first, claim.attempt, now);
}

async function announceClaimed(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  group: string,
): Promise<void> {
  const clock = clockOf(deps);
  const claim = await store.claimAnnouncement(ctx.guildId, group, clock(), ANNOUNCE_LEASE_MS);
  if (!claim) return;

  let outcome: AnnouncementOutcome | null;
  try {
    outcome = await deliverAnnouncement(ctx, deps, store, claim, clock());
  } catch (error) {
    outcome = {
      status: claim.attempt < MAX_ANNOUNCE_ATTEMPTS ? 'pending' : 'failed',
      error: `Proton hit an unexpected problem announcing this: ${reasonOf(error)}`,
      now: clock(),
    };
  }

  if (outcome === null) return;
  await store.finishAnnouncement(ctx.guildId, group, claim.attempt, outcome);

  if (outcome.status === 'failed' || outcome.status === 'pending') {
    ctx.logger.warn(
      `achievements could not announce an unlock (group ${group}): ${outcome.error ?? 'no reason'}` +
        (outcome.status === 'pending' ? ' It will be tried again.' : ''),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

export async function announceIfReady(
  ctx: Context,
  deps: AchievementsDeps,
  input: { userId: string; achievementId: string; generation: number; group: string },
): Promise<void> {
  const store = deps.store;
  if (!store) return;

  const pending = (await store.unlocksOf(ctx.guildId, input.userId)).filter(
    (row) => row.announceGroup === input.group && row.announceStatus === 'pending',
  );
  if (pending.length === 0) return;

  const tiers = new Set(pending.map((row) => row.tierId));
  const rewards = (
    await store.rewardsFor(ctx.guildId, input.userId, input.achievementId, input.generation)
  ).filter((row) => tiers.has(row.tierId));

  const oldest = Math.min(...pending.map((row) => row.unlockedAt));
  const waited = clockOf(deps)() - oldest >= XP_CONFIRM_TIMEOUT_MS;
  if (!waited && !rewards.every(isSettled)) return;

  await announceClaimed(ctx, deps, store, input.group);
}

export async function announceUnlockOf(
  ctx: Context,
  deps: AchievementsDeps,
  input: { userId: string; achievementId: string; tierId: TierId; generation: number },
): Promise<void> {
  const store = deps.store;
  if (!store) return;

  const row = (await store.unlocksOf(ctx.guildId, input.userId)).find(
    (candidate) =>
      candidate.achievementId === input.achievementId &&
      candidate.tierId === input.tierId &&
      candidate.generation === input.generation,
  );
  if (row?.announceStatus !== 'pending') return;

  await announceIfReady(ctx, deps, {
    userId: input.userId,
    achievementId: input.achievementId,
    generation: input.generation,
    group: row.announceGroup,
  });
}

export async function announceDueGroup(
  ctx: Context,
  deps: AchievementsDeps,
  group: AnnounceGroup,
): Promise<void> {
  const store = deps.store;
  if (!store) return;
  await announceClaimed(ctx, deps, store, group.group);
}

export interface AlmostThereInput {
  userId: string;
  achievement: Achievement;
  generation: number;
  tierId: TierId;
  values: Readonly<Record<string, number>>;
  unlocked: readonly TierId[];
  originChannelId: string | null;
}

export async function sendAlmostThere(
  ctx: Context,
  deps: AchievementsDeps,
  input: AlmostThereInput,
): Promise<boolean> {
  const store = deps.store;
  if (!store) return false;

  const config = ctx.config;
  const route = almostThereRoute(config);
  if (isSilentMessage(route.message)) return false;

  const target: Target | null =
    route.destination === 'dm'
      ? DM
      : route.destination === 'channel'
        ? route.channelId === null
          ? null
          : channel(route.channelId)
        : input.originChannelId === null
          ? null
          : channel(input.originChannelId);
  if (target === null) return false;

  const { achievement, tierId, userId } = input;
  const clock = clockOf(deps);
  const now = clock();
  const cooldown = tryParseDuration(config.almostThere.cooldown) ?? DAY_MS;

  const claimed = await store.claimAlmostThere(
    ctx.guildId,
    userId,
    achievement.id,
    tierId,
    input.generation,
    now,
    cooldown,
  );
  if (!claimed) return false;

  const tier = achievement.tiers.find(({ id }) => id === tierId);
  const nameOf = nameLookup(config);
  const requirements = achievement.requirements.map((requirement) =>
    requirementFact(
      requirement,
      tier?.targets[requirement.id] ?? 0,
      input.values[requirement.id] ?? 0,
      nameOf,
    ),
  );

  const kit = await factsFor(ctx, deps, route, {
    userId,
    achievement: {
      id: achievement.id,
      name: achievement.name,
      description: achievement.description,
      kind: achievement.kind,
      tierCount: achievement.tiers.length,
    },
    tier: tierId,
    tiersUnlocked: currentTierIds(achievement, input.unlocked),
    requirements,
    rewards: null,
    unlockedAt: null,
    deadline: instant(achievement.endsAt),
    originChannelId: input.originChannelId,
  });

  const rendered = renderAchievementMessage(
    route.kind,
    route.message,
    kit.destination(target),
    now,
    route.basePath,
  );

  const root = `achievements:${ctx.guildId}:${userId}:${achievement.id}:${input.generation}:${tierId}:almost`;
  let sent: Sent;

  if (!rendered.ok) {
    sent = { status: 'unrendered', reason: rendered.humanReason };
  } else {
    try {
      const body = toSendBody(
        target.kind === 'dm' ? 'almost_there_dm' : 'almost_there',
        rendered.message,
        now,
      );
      sent = await send(ctx, target, userId, body, { send: root, open: `${root}:dm-open` });
    } catch (error) {
      sent = { status: 'unrendered', reason: reasonOf(error) };
    }
  }

  if (sent.status === 'sent' || sent.status === 'duplicate') return true;

  const why = sent.status === 'failed' ? sent.failure.humanReason : sent.reason;
  ctx.logger.warn(
    `achievements could not tell ${userId} they are close to ${achievement.name}: ${why}`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId },
  );
  return false;
}
