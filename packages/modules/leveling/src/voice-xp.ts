import {
  type EventListener,
  type EventType,
  isVoiceEligible,
  type ModuleContext,
  type ProtonEvent,
  readVoiceState,
  type VoiceState,
} from '@proton/core';
import type { LevelingConfig } from './config.ts';
import { bindVoice, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { channelChainFor, xpEventsBetween } from './multiplier-lookup.ts';
import { staticXpCandidates, voiceXpPayout } from './multipliers.ts';
import { MODULE_ID } from './perform.ts';
import { organicCausation, publishXpAwarded } from './publish.ts';
import type { MemberXpStore } from './store.ts';
import { MAX_PAID_SESSION_MS, type VoiceSession } from './voice-session.ts';

export { readVoiceState, type VoiceState } from '@proton/core';

export const VOICE_XP_EVENT_TYPES: EventType[] = ['voice.state_updated', 'guild.available'];

const MINUTE_MS = 60_000;

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readMembers(members: unknown): Map<string, VoiceState> {
  const states = new Map<string, VoiceState>();
  if (!Array.isArray(members)) return states;

  for (const member of members) {
    const state = readVoiceState({ user_id: field(field(member, 'user'), 'id'), member });
    if (state !== null) states.set(state.userId, state);
  }

  return states;
}

function sameRoles(held: readonly string[] | undefined, fresh: readonly string[]): boolean {
  if (held === undefined || held.length !== fresh.length) return false;

  const holding = new Set(held);
  return fresh.every((roleId) => holding.has(roleId));
}

function sessionFor(guildId: string, state: VoiceState, channelId: string, joinedAt: number) {
  return {
    guildId,
    userId: state.userId,
    channelId,
    joinedAt,
    ...(state.roleIds === null ? {} : { roleIds: state.roleIds }),
  };
}

async function excludedChannels(
  ctx: ModuleContext<LevelingConfig>,
  deps: LevelingDeps,
  guildId: string,
): Promise<ReadonlySet<string>> {
  const excluded = new Set<string>();
  if (ctx.config.afkChannelId !== undefined) excluded.add(ctx.config.afkChannelId);
  if (!deps.guildState) return excluded;

  try {
    const afkChannelId = (await deps.guildState.get(guildId))?.afkChannelId;
    if (afkChannelId) excluded.add(afkChannelId);
  } catch (error) {
    ctx.logger.warn(
      `leveling could not read server ${guildId}'s AFK channel, so a member idling there earns ` +
        `voice XP until it can: ${error instanceof Error ? error.message : String(error)}`,
      { guildId, moduleId: MODULE_ID },
    );
  }

  return excluded;
}

export function createVoiceXpListener(deps: LevelingDeps): EventListener<LevelingConfig> {
  return {
    types: VOICE_XP_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;
      if (event.guildId === null) return;

      if (ctx.config.voiceXpPerMinute <= 0) return;

      const bound = bindVoice(deps);
      if ('unbound' in bound) {
        ctx.logger.error(describeUnbound('voice XP', bound.unbound), {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      if (event.type === 'guild.available') {
        await reconcile(ctx, deps, event, bound.sessions);
        return;
      }

      const state = readVoiceState(event.payload);
      if (state === null) return;

      if (state.isBot === true) return;

      const active =
        state.channelId !== null &&
        isVoiceEligible(state, {
          excludedChannelIds: await excludedChannels(ctx, deps, event.guildId),
        });

      if (active) {
        const open = await bound.sessions.get(event.guildId, state.userId);

        if (open && open.channelId === state.channelId) {
          if (state.roleIds !== null && !sameRoles(open.roleIds, state.roleIds)) {
            await bound.sessions.open({ ...open, roleIds: state.roleIds });
          }
          return;
        }
      }

      const closed = await bound.sessions.close(event.guildId, state.userId);
      if (closed) await payout(ctx, deps, bound.xp, event, closed);

      if (active && state.channelId !== null) {
        await bound.sessions.open(
          sessionFor(event.guildId, state, state.channelId, event.occurredAt),
        );
      }
    },
  };
}

async function payout(
  ctx: ModuleContext<LevelingConfig>,
  deps: LevelingDeps,
  xp: MemberXpStore,
  event: ProtonEvent,
  session: VoiceSession,
): Promise<void> {
  const elapsed = Math.min(Math.max(0, event.occurredAt - session.joinedAt), MAX_PAID_SESSION_MS);
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes <= 0) return;

  const paidUntil = session.joinedAt + minutes * MINUTE_MS;

  const amount = voiceXpPayout({
    joinedAt: session.joinedAt,
    minutes,
    voiceXpPerMinute: ctx.config.voiceXpPerMinute,
    staticCandidates: staticXpCandidates(ctx.config, {
      guildId: session.guildId,
      roleIds: session.roleIds ?? [],
      channelChain: await channelChainFor(ctx, deps, session.guildId, session.channelId),
    }),
    events: await xpEventsBetween(ctx, deps, session.guildId, session.joinedAt, paidUntil),
  });

  if (amount <= 0) {
    ctx.logger.info(
      `voice session of ${minutes} minute(s) earned no XP: a 0× multiplier applied to it`,
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        userId: session.userId,
        channelId: session.channelId,
      },
    );
    return;
  }

  let result: Awaited<ReturnType<typeof xp.creditVoice>>;
  try {
    result = await xp.creditVoice({
      guildId: session.guildId,
      userId: session.userId,
      amount,
      seconds: minutes * 60,
      now: event.occurredAt,
    });
  } catch (error) {
    ctx.logger.error(
      `leveling could not credit ${amount} voice XP to ${session.userId}: ` +
        `${error instanceof Error ? error.message : String(error)}. That session is gone; ` +
        'the member keeps whatever they had.',
      { guildId: ctx.guildId, moduleId: MODULE_ID, userId: session.userId },
    );
    return;
  }

  ctx.logger.info(`voice session paid: ${minutes} minute(s), ${amount} XP`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    userId: session.userId,
    channelId: session.channelId,
  });

  const causation = organicCausation(event.id);

  // Before the level-up, not after: the session was taken by GETDEL, so if applyLevelUp throws the
  // redelivered event finds nothing to pay and a publish after it is lost for the whole stay.
  await publishXpAwarded(ctx, `voice:${session.userId}:${session.joinedAt}`, {
    userId: session.userId,
    amount,
    source: 'voice',
    channelId: session.channelId,
    activityAt: event.occurredAt,
    xp: result.xp,
    level: result.level,
    causation,
  });

  await applyLevelUp(
    ctx,
    {
      userId: session.userId,
      previousLevel: result.previousLevel,
      level: result.level,
      xp: result.xp,
      source: 'voice',
      idempotencyRoot: `leveling:${event.id}`,
      gained: amount,
      causation,
    },
    deps,
  );
}

async function reconcile(
  ctx: ModuleContext<LevelingConfig>,
  deps: LevelingDeps,
  event: ProtonEvent,
  sessions: NonNullable<LevelingDeps['sessions']>,
): Promise<void> {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return;

  const raw = (payload as Record<string, unknown>).voice_states;
  if (!Array.isArray(raw)) return;

  const guildId = event.guildId;
  if (guildId === null) return;

  // GUILD_CREATE voice states carry no member, so roles and the bot flag come from its members list.
  const members = readMembers((payload as Record<string, unknown>).members);
  const excludedChannelIds = await excludedChannels(ctx, deps, guildId);

  let adopted = 0;
  for (const entry of raw) {
    const read = readVoiceState(entry);
    if (read === null) continue;

    const member = members.get(read.userId);
    const state: VoiceState = {
      ...read,
      isBot: read.isBot ?? member?.isBot ?? null,
      roleIds: read.roleIds ?? member?.roleIds ?? null,
    };

    if (state.isBot === true) continue;
    if (!isVoiceEligible(state, { excludedChannelIds }) || state.channelId === null) continue;

    if (await sessions.get(guildId, state.userId)) continue;

    await sessions.open(sessionFor(guildId, state, state.channelId, event.occurredAt));
    adopted++;
  }

  if (adopted > 0) {
    ctx.logger.info(`adopted ${adopted} voice session(s) already in progress`, {
      guildId,
      moduleId: MODULE_ID,
    });
  }
}
