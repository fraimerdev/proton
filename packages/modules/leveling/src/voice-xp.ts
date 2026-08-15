import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import type { LevelingConfig } from './config.ts';
import { bindVoice, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { MODULE_ID } from './perform.ts';
import type { MemberXpStore } from './store.ts';
import { MAX_PAID_SESSION_MS, type VoiceSession } from './voice-session.ts';

export const VOICE_XP_EVENT_TYPES: EventType[] = ['voice.state_updated', 'guild.available'];

const MINUTE_MS = 60_000;

export interface VoiceState {
  userId: string;

  channelId: string | null;
  selfDeaf: boolean;
  serverDeaf: boolean;

  isBot: boolean | null;
}

export function readVoiceState(payload: unknown): VoiceState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  const userId = typeof raw.user_id === 'string' ? raw.user_id : null;
  if (userId === null) return null;

  const member = typeof raw.member === 'object' && raw.member !== null ? raw.member : null;
  const user = member === null ? null : (member as Record<string, unknown>).user;
  const bot =
    typeof user === 'object' && user !== null ? (user as Record<string, unknown>).bot : undefined;

  return {
    userId,
    channelId: typeof raw.channel_id === 'string' ? raw.channel_id : null,
    selfDeaf: raw.self_deaf === true,
    serverDeaf: raw.deaf === true,
    isBot: typeof bot === 'boolean' ? bot : null,
  };
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
        await reconcile(ctx, event, bound.sessions);
        return;
      }

      const state = readVoiceState(event.payload);
      if (state === null) return;

      if (state.isBot === true) return;

      const active = isEarning(ctx.config, state);

      if (active) {
        const open = await bound.sessions.get(event.guildId, state.userId);
        if (open && open.channelId === state.channelId) return;
      }

      const closed = await bound.sessions.close(event.guildId, state.userId);
      if (closed) await payout(ctx, bound.xp, event, closed);

      if (active && state.channelId !== null) {
        await bound.sessions.open({
          guildId: event.guildId,
          userId: state.userId,
          channelId: state.channelId,

          joinedAt: event.occurredAt,
        });
      }
    },
  };
}

function isEarning(config: LevelingConfig, state: VoiceState): boolean {
  if (state.channelId === null) return false;

  if (config.afkChannelId !== undefined && state.channelId === config.afkChannelId) return false;

  return !state.selfDeaf && !state.serverDeaf;
}

async function payout(
  ctx: ModuleContext<LevelingConfig>,
  xp: MemberXpStore,
  event: ProtonEvent,
  session: VoiceSession,
): Promise<void> {
  const elapsed = Math.min(Math.max(0, event.occurredAt - session.joinedAt), MAX_PAID_SESSION_MS);
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes <= 0) return;

  const amount = minutes * ctx.config.voiceXpPerMinute;

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

  await applyLevelUp(ctx, {
    userId: session.userId,
    previousLevel: result.previousLevel,
    level: result.level,
    xp: result.xp,
    source: 'voice',
    idempotencyRoot: `leveling:${event.id}`,
  });
}

async function reconcile(
  ctx: ModuleContext<LevelingConfig>,
  event: ProtonEvent,
  sessions: NonNullable<LevelingDeps['sessions']>,
): Promise<void> {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return;

  const raw = (payload as Record<string, unknown>).voice_states;
  if (!Array.isArray(raw)) return;

  const guildId = event.guildId;
  if (guildId === null) return;

  let adopted = 0;
  for (const entry of raw) {
    const state = readVoiceState(entry);
    if (state === null || state.isBot === true) continue;
    if (!isEarning(ctx.config, state) || state.channelId === null) continue;

    if (await sessions.get(guildId, state.userId)) continue;

    await sessions.open({
      guildId,
      userId: state.userId,
      channelId: state.channelId,

      joinedAt: event.occurredAt,
    });
    adopted++;
  }

  if (adopted > 0) {
    ctx.logger.info(`adopted ${adopted} voice session(s) already in progress`, {
      guildId,
      moduleId: MODULE_ID,
    });
  }
}
