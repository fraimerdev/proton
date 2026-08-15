import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import type { LevelingConfig } from './config.ts';
import { bindVoice, describeUnbound, type LevelingDeps } from './deps.ts';
import { applyLevelUp } from './level-up.ts';
import { MODULE_ID } from './perform.ts';
import type { MemberXpStore } from './store.ts';
import { MAX_PAID_SESSION_MS, type VoiceSession } from './voice-session.ts';

export const VOICE_XP_EVENT_TYPES: EventType[] = ['voice.state_updated', 'guild.available'];

const MINUTE_MS = 60_000;

/** The fields of a voice state this module reads. */
export interface VoiceState {
  userId: string;
  /** Null means disconnected from voice in this guild entirely (verified). */
  channelId: string | null;
  selfDeaf: boolean;
  serverDeaf: boolean;
  /** Null when the payload carried no member object — a disconnect never does. */
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

/**
 * Voice XP (docs/PHASE-3.md §3.B; §6's `voice_seconds` column, declared and
 * unused since Gate 0).
 *
 * The design in one sentence: the store holds **"in channel X since T"**, and
 * every transition is expressed as close-then-maybe-open, so re-applying a
 * transition changes nothing. That is what makes a worker restart a non-event —
 * the session outlives the process in Redis, a redelivered join finds the
 * session it already opened and returns, and a redelivered disconnect finds
 * nothing to close because closing is an atomic take.
 *
 * What it deliberately does not do, and why:
 *
 *  - **It does not require another non-bot occupant in the channel.** The plan
 *    lists that as a third farming guard, and it is a good one, but it needs a
 *    per-channel occupancy set that nothing in Proton maintains — voice states
 *    arrive per member, and reconstructing "who else is in here" means keeping a
 *    second Redis structure in step with every join, move and disconnect in
 *    every guild. That is its own slice. The AFK-channel and self-deafen guards
 *    are here; the occupancy guard is a named gap, not an oversight.
 *  - **It does not tick.** Nothing accrues while a member sits in a channel; the
 *    payout happens once, on the way out. A periodic tick would be a write per
 *    member per interval across every guild, and it would have to be idempotent
 *    against redelivery anyway — which is the property the join timestamp gives
 *    for free.
 */
export function createVoiceXpListener(deps: LevelingDeps): EventListener<LevelingConfig> {
  return {
    types: VOICE_XP_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;
      if (event.guildId === null) return;

      // Zero is a guild switching voice XP off. Sessions are not even tracked
      // then: writing keys nobody will ever be paid from is a cost with no
      // matching benefit, and turning the setting on starts counting from the
      // next join, which is what an admin flipping it expects.
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

      // Music and soundboard bots would otherwise top every voice leaderboard.
      // Only join payloads carry a member object, which is enough: a bot that
      // never opened a session has nothing to close.
      if (state.isBot === true) return;

      const active = isEarning(ctx.config, state);

      // The idempotent no-op. A redelivered join for the channel the member is
      // already recorded in must not restart the clock — that would silently
      // discard everything they had accrued.
      if (active) {
        const open = await bound.sessions.get(event.guildId, state.userId);
        if (open && open.channelId === state.channelId) return;
      }

      // Close first, always: a move pays for the channel being left before the
      // new one is opened, and a disconnect is the same act without the reopen.
      const closed = await bound.sessions.close(event.guildId, state.userId);
      if (closed) await payout(ctx, bound.xp, event, closed);

      if (active && state.channelId !== null) {
        await bound.sessions.open({
          guildId: event.guildId,
          userId: state.userId,
          channelId: state.channelId,
          // The event's time, so a replay opens the session where it originally
          // opened rather than wherever the clock happens to be.
          joinedAt: event.occurredAt,
        });
      }
    },
  };
}

/** Whether this state is one Proton pays for. */
function isEarning(config: LevelingConfig, state: VoiceState): boolean {
  if (state.channelId === null) return false;

  // The AFK channel is where Discord itself puts people who have stopped
  // participating. Paying for it would make the top of the voice leaderboard
  // whoever leaves the client running overnight.
  if (config.afkChannelId !== undefined && state.channelId === config.afkChannelId) return false;

  // Deafened means not listening — server-deafened is usually a moderator saying
  // so. Muted is not the same thing and is not excluded: plenty of people listen
  // to a stage or a movie night without speaking, and that is participation.
  return !state.selfDeaf && !state.serverDeaf;
}

/**
 * Pay for a session that has just closed.
 *
 * Whole minutes only, and nothing at all under a minute: channel-hopping would
 * otherwise be one database write per hop for zero XP, and a leaderboard
 * measured in seconds invites exactly that behaviour.
 *
 * The elapsed time is clamped to `MAX_PAID_SESSION_MS`, which is also the TTL on
 * the session key — so a session Proton somehow lost track of pays for at most a
 * day rather than for however long the key survived.
 */
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
    // Swallowed for the same reason the message listener swallows: a throw asks
    // the bus to redeliver, and a redelivery finds the session already closed —
    // so the retry could never pay what the failure lost, and would cost every
    // module behind this one on the stream.
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
    // No origin channel: a voice channel is not somewhere to post a level-up
    // message, so a guild that wants one has to name a text channel.
  });
}

/**
 * Adopt the members already sitting in voice when the guild becomes available.
 *
 * GUILD_CREATE carries the guild's live `voice_states`, which is the only way to
 * learn about a member who joined a channel while Proton was not connected —
 * their VOICE_STATE_UPDATE happened to nobody. Without this they would earn
 * nothing until they next moved, which after a deploy is every member currently
 * in voice.
 *
 * Existing sessions are left exactly as they are, which is what keeps this safe
 * to run on every reconnect: adoption only ever *adds* a session, so it can
 * neither double-award nor shorten one that survived the restart in Redis.
 *
 * Orphans — sessions for members who left while Proton was away — are not closed
 * here. Doing so would need to enumerate this guild's session keys, which the
 * store deliberately cannot do (a SCAN across every guild's keys on every
 * reconnect). They expire instead, and `MAX_PAID_SESSION_MS` bounds what one
 * could ever pay before it does.
 */
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
      // From the reconnect, not from whenever they actually joined: Proton has no
      // idea how long they had been there, and inventing a start time would pay
      // for time it never observed.
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
