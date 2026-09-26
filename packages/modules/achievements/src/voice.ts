import {
  type GuildState,
  isVoiceEligible,
  MAX_VOICE_STAY_MS,
  type ProtonEvent,
  readVoiceState,
  type VoiceState,
} from '@proton/core';
import type { ActivityRecord } from './activity.ts';
import {
  activeDayRecord,
  activityRecord,
  type Chain,
  type CollectorEngine,
  type Ctx,
  chainOf,
  channelKindOf,
  DISCORD_SOURCE,
  ENGINE,
  excludedByRole,
  excludedChain,
  guildStateOf,
  instantOf,
  type MemberPayload,
  markActiveDays,
  objectAt,
  organicCausation,
  own,
  reasonOf,
  rememberFacts,
  submit,
  text,
} from './collect/common.ts';
import { MODULE_ID } from './config.ts';
import { VOICE_CHECKPOINT_MS } from './constants.ts';
import {
  type AchievementsDeps,
  bindVoice,
  clockOf,
  describeUnbound,
  type FencedLocks,
  type VoiceBinding,
} from './deps.ts';
import type { SubjectFacts } from './engine.ts';
import type { AchievementStore } from './store.ts';
import type { AchievementVoiceSession } from './voice-store.ts';

export const VOICE_JOB_ID = 'voice';
export const VOICE_LOCK_TTL_MS = 30_000;
export const VOICE_LOCK_WAIT_MS = 3_000;

const LOCK_POLL_MS = 100;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type BoundVoice = Exclude<VoiceBinding, { unbound: string[] }>;

interface Verdict {
  eligible: boolean;
  temporary: boolean;
}

const INELIGIBLE: Verdict = { eligible: false, temporary: false };

export function voiceLockKey(guildId: string, userId: string): string {
  return `voice:${guildId}:${userId}`;
}

function bindOrLog(ctx: Ctx, deps: AchievementsDeps): BoundVoice | null {
  const bound = bindVoice(deps);
  if (!('unbound' in bound)) return bound;

  ctx.logger.error(describeUnbound('voice time', bound.unbound), {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
  });
  return null;
}

async function acquireWaiting(locks: FencedLocks, key: string): Promise<string | null> {
  const deadline = Date.now() + VOICE_LOCK_WAIT_MS;

  for (;;) {
    const token = await locks.acquire(key, VOICE_LOCK_TTL_MS);
    if (token !== null || Date.now() >= deadline) return token;
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

async function release(ctx: Ctx, locks: FencedLocks, key: string, token: string): Promise<void> {
  try {
    await locks.release(key, token);
  } catch (error) {
    ctx.logger.warn(
      `achievements could not release the voice lock ${key}; it expires by itself within ` +
        `${VOICE_LOCK_TTL_MS / 1000} s: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

function memberOf(state: VoiceState): MemberPayload {
  const present = state.roleIds !== null;
  return {
    present,
    roleIds: state.roleIds,
    joinedAt: present ? instantOf(state.joinedAt) : undefined,
    premiumSince: present ? instantOf(state.premiumSince) : undefined,
  };
}

function voiceSubject(state: VoiceState): SubjectFacts {
  return {
    roleIds: state.roleIds,
    isMember: state.roleIds === null ? null : true,
    isBot: state.isBot,
  };
}

async function verdictFor(
  ctx: Ctx,
  deps: AchievementsDeps,
  state: VoiceState,
  guild: GuildState | null,
): Promise<Verdict> {
  const channelId = state.channelId;
  if (channelId === null) return INELIGIBLE;

  const excluded = new Set<string>();
  if (guild?.afkChannelId) excluded.add(guild.afkChannelId);
  if (excludedChain(ctx.config, chainOf(channelId, guild))) excluded.add(channelId);

  if (!isVoiceEligible(state, { excludedChannelIds: excluded })) return INELIGIBLE;
  if (excludedByRole(ctx.config, state.roleIds)) return INELIGIBLE;

  const kind = await channelKindOf(deps, ctx.guildId, channelId);
  if (kind === 'ticket') return INELIGIBLE;

  return { eligible: true, temporary: kind === 'temporary' };
}

async function modulePeriodStart(store: AchievementStore, guildId: string): Promise<number | null> {
  const { modulePeriods } = await store.runtime(guildId);
  return modulePeriods.find((period) => period.end === null)?.start ?? null;
}

function daySamples(start: number, end: number): number[] {
  const samples: number[] = [];
  for (let at = start; at < end; at += HOUR_MS) samples.push(at);
  samples.push(end - 1);
  return samples;
}

interface Span {
  records: ActivityRecord[];
  marks: string[];
  start: number;
  minutes: number;
}

function spanRecords(
  ctx: Ctx,
  deps: AchievementsDeps,
  input: {
    userId: string;
    session: AchievementVoiceSession;
    until: number;
    periodStart: number | null;
    chain: Chain;
    rootId: string;
  },
): Span {
  const { userId, session, periodStart, chain } = input;
  const end = Math.min(input.until, session.startedAt + MAX_VOICE_STAY_MS);
  const start = Math.max(session.joinedAt, periodStart ?? session.joinedAt);
  const minutes = Math.floor((end - start) / MINUTE_MS);
  if (minutes < 1) return { records: [], marks: [], start, minutes: 0 };

  const shared = {
    userId,
    occurredAt: end,
    sourceModule: DISCORD_SOURCE,
    causation: organicCausation(input.rootId),
    chain,
    temporary: session.temporary,
  };
  const records: ActivityRecord[] = [];
  const marks: string[] = [];

  const counted = activityRecord(ctx, {
    ...shared,
    metric: 'voice_minutes',
    sourceKey: `${userId}:${session.channelId}:${session.joinedAt}`,
    spanStart: start,
    amount: minutes,
  });
  if (counted) records.push(counted);

  const stayStart = Math.max(session.startedAt, periodStart ?? session.startedAt);
  const stayMinutes = Math.floor((end - stayStart) / MINUTE_MS);
  if (stayMinutes >= 1) {
    const stay = activityRecord(ctx, {
      ...shared,
      metric: 'voice_stay',
      // Keyed per saved segment too: a stay grows at every checkpoint and a reused key is deduped.
      sourceKey: `${userId}:${session.channelId}:${session.startedAt}:${session.joinedAt}`,
      spanStart: stayStart,
      amount: stayMinutes,
    });
    if (stay) records.push(stay);
  }

  for (const at of daySamples(start, end)) {
    const day = activeDayRecord(ctx, deps, { ...shared, temporary: false, occurredAt: at });
    if (day === null || marks.includes(day.mark)) continue;
    records.push(day.record);
    marks.push(day.mark);
  }

  return { records, marks, start, minutes };
}

async function saveSpan(
  ctx: Ctx,
  deps: AchievementsDeps,
  engine: CollectorEngine,
  span: Span,
  userId: string,
  subject: SubjectFacts | null,
  onRecorded?: (record: ActivityRecord) => Promise<void>,
): Promise<void> {
  if (span.records.length === 0) return;

  await submit(ctx, deps, engine, {
    records: span.records,
    ...(subject ? { subjects: new Map([[userId, subject]]) } : {}),
    ...(onRecorded ? { onRecorded } : {}),
    originChannelId: null,
  });
  markActiveDays(deps, span.marks);
}

async function armCheckpoint(ctx: Ctx, deps: AchievementsDeps): Promise<void> {
  if (!ctx.schedule) {
    ctx.logger.warn(
      'achievements could not arm its voice checkpoint: this module’s context has no schedule ' +
        'port, so voice time is only saved when members leave or move.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  await ctx.schedule(
    VOICE_JOB_ID,
    new Date(clockOf(deps)() + VOICE_CHECKPOINT_MS),
    VOICE_JOB_ID,
    {},
  );
}

async function applyVoiceState(
  ctx: Ctx,
  deps: AchievementsDeps,
  engine: CollectorEngine,
  bound: BoundVoice,
  event: ProtonEvent,
  state: VoiceState,
): Promise<void> {
  const guildId = ctx.guildId;
  const at = event.occurredAt;

  const session = await bound.voice.get(guildId, state.userId);
  if (session && at <= session.lastEventAt) return;

  await rememberFacts(deps, bound.store, guildId, state.userId, memberOf(state));

  const guild = await guildStateOf(ctx, deps, guildId);
  const verdict = await verdictFor(ctx, deps, state, guild);

  if (session && verdict.eligible && session.channelId === state.channelId) {
    await bound.voice.advance(guildId, state.userId, session.joinedAt, { lastEventAt: at });
    return;
  }

  if (session) {
    const span = spanRecords(ctx, deps, {
      userId: state.userId,
      session,
      until: at,
      periodStart: await modulePeriodStart(bound.store, guildId),
      chain: chainOf(session.channelId, guild),
      rootId: event.id,
    });
    await saveSpan(ctx, deps, engine, span, state.userId, voiceSubject(state));
    // A millisecond early, so the tombstone does not refuse the session this update reopens.
    await bound.voice.close(guildId, state.userId, session.joinedAt, at - 1);
  } else if (!verdict.eligible) {
    await bound.voice.markLeft(guildId, state.userId, at);
  }

  if (verdict.eligible && state.channelId !== null) {
    await armCheckpoint(ctx, deps);
    await bound.voice.open(guildId, state.userId, {
      channelId: state.channelId,
      joinedAt: at,
      startedAt: at,
      lastEventAt: at,
      temporary: verdict.temporary,
    });
  }
}

export async function handleVoiceState(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  if (event.guildId === null) return;

  const state = readVoiceState(event.payload);
  if (state === null || state.isBot === true) return;

  const bound = bindOrLog(ctx, deps);
  if (!bound) return;

  const key = voiceLockKey(ctx.guildId, state.userId);
  const token = await acquireWaiting(bound.locks, key);
  if (token === null) {
    throw new Error(
      `achievements could not take the voice lock for member ${state.userId} within ` +
        `${VOICE_LOCK_WAIT_MS / 1000} s, so this voice update will be retried`,
    );
  }

  try {
    await applyVoiceState(ctx, deps, engine, bound, event, state);
  } finally {
    await release(ctx, bound.locks, key, token);
  }
}

function readMembers(members: unknown): Map<string, VoiceState> {
  const states = new Map<string, VoiceState>();
  if (!Array.isArray(members)) return states;

  for (const member of members) {
    const state = readVoiceState({ user_id: text(objectAt(member, 'user'), 'id'), member });
    if (state !== null) states.set(state.userId, state);
  }

  return states;
}

export async function reconcileVoice(
  ctx: Ctx,
  deps: AchievementsDeps,
  event: ProtonEvent,
): Promise<void> {
  if (event.guildId === null) return;

  const entries = own(event.payload, 'voice_states');
  if (!Array.isArray(entries)) return;

  const bound = bindOrLog(ctx, deps);
  if (!bound) return;

  const guildId = ctx.guildId;
  const at = event.occurredAt;
  const members = readMembers(own(event.payload, 'members'));
  const guild = await guildStateOf(ctx, deps, guildId);

  const present = new Map<string, VoiceState>();
  for (const entry of entries) {
    const read = readVoiceState(entry);
    if (read === null) continue;

    const member = members.get(read.userId);
    present.set(read.userId, {
      ...read,
      isBot: read.isBot ?? member?.isBot ?? null,
      roleIds: read.roleIds ?? member?.roleIds ?? null,
    });
  }

  const open = await bound.voice.list(guildId);
  const userIds = [...new Set([...open.map((entry) => entry.userId), ...present.keys()])].sort();
  let closed = 0;
  let opened = 0;

  for (const userId of userIds) {
    const key = voiceLockKey(guildId, userId);
    const token = await bound.locks.acquire(key, VOICE_LOCK_TTL_MS);
    if (token === null) continue;

    try {
      const session = await bound.voice.get(guildId, userId);
      if (session && session.lastEventAt >= at) continue;

      const state = present.get(userId);
      const verdict = state ? await verdictFor(ctx, deps, state, guild) : INELIGIBLE;
      if (session && verdict.eligible && session.channelId === state?.channelId) continue;

      if (session && (await bound.voice.close(guildId, userId, session.joinedAt, at - 1))) {
        closed++;
      }

      if (verdict.eligible && state?.channelId) {
        const started = await bound.voice.open(guildId, userId, {
          channelId: state.channelId,
          joinedAt: at,
          startedAt: at,
          lastEventAt: at,
          temporary: verdict.temporary,
        });
        if (started) opened++;
      }
    } finally {
      await release(ctx, bound.locks, key, token);
    }
  }

  if (closed > 0 || opened > 0) {
    ctx.logger.info(
      `achievements reconciled voice after a reconnect: adopted ${opened} stay(s) already in ` +
        `progress and dropped ${closed} it could no longer see, without counting their time`,
      { guildId, moduleId: MODULE_ID },
    );
  }

  if ((await bound.voice.list(guildId)).length > 0) await armCheckpoint(ctx, deps);
}

export async function closeAllVoice(
  ctx: Ctx,
  deps: AchievementsDeps,
  reason: 'disabled',
): Promise<void> {
  if (!deps.voice) return;

  const closedAt = clockOf(deps)();
  let closed = 0;

  for (const { userId, session } of await deps.voice.list(ctx.guildId)) {
    if (await deps.voice.close(ctx.guildId, userId, session.joinedAt, closedAt)) closed++;
  }

  if (closed > 0) {
    ctx.logger.info(
      `achievements ended ${closed} voice stay(s) without counting them: the module was ${reason}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

async function checkpointSession(
  ctx: Ctx,
  deps: AchievementsDeps,
  engine: CollectorEngine,
  bound: BoundVoice,
  input: {
    userId: string;
    session: AchievementVoiceSession;
    now: number;
    periodStart: number | null;
    guild: GuildState | null;
  },
): Promise<void> {
  const { userId, session, now } = input;
  const span = spanRecords(ctx, deps, {
    userId,
    session,
    until: now,
    periodStart: input.periodStart,
    chain: chainOf(session.channelId, input.guild),
    rootId: `voice:${userId}:${session.joinedAt}`,
  });

  const capped = now >= session.startedAt + MAX_VOICE_STAY_MS;
  const advance = () =>
    bound.voice.advance(ctx.guildId, userId, session.joinedAt, {
      joinedAt: span.start + span.minutes * MINUTE_MS,
    });

  // The minutes row is keyed on joinedAt, so a later failure would dedupe the retry away.
  const settle =
    capped || span.minutes === 0
      ? undefined
      : async (record: ActivityRecord) => {
          if (record.metric === 'voice_minutes') await advance();
        };

  await saveSpan(ctx, deps, engine, span, userId, null, settle);

  if (capped) {
    await bound.voice.close(ctx.guildId, userId, session.joinedAt, now);
    return;
  }

  if (span.minutes > 0) await advance();
}

export async function voiceCheckpoint(
  _data: unknown,
  ctx: Ctx,
  deps: AchievementsDeps,
  engine: CollectorEngine = ENGINE,
): Promise<void> {
  if (!ctx.config.enabled) return;

  const bound = bindOrLog(ctx, deps);
  if (!bound) return;

  const guildId = ctx.guildId;
  const open = await bound.voice.list(guildId);
  if (open.length === 0) return;

  const now = clockOf(deps)();
  const guild = await guildStateOf(ctx, deps, guildId);
  const periodStart = await modulePeriodStart(bound.store, guildId);

  for (const { userId } of open) {
    const key = voiceLockKey(guildId, userId);
    const token = await bound.locks.acquire(key, VOICE_LOCK_TTL_MS);
    if (token === null) continue;

    try {
      const session = await bound.voice.get(guildId, userId);
      if (session) {
        await checkpointSession(ctx, deps, engine, bound, {
          userId,
          session,
          now,
          periodStart,
          guild,
        });
      }
    } catch (error) {
      ctx.logger.warn(
        `achievements could not save the voice time of ${userId}; the next checkpoint tries ` +
          `again: ${reasonOf(error)}`,
        { guildId, moduleId: MODULE_ID, userId },
      );
    } finally {
      await release(ctx, bound.locks, key, token);
    }
  }

  if ((await bound.voice.list(guildId)).length > 0) await armCheckpoint(ctx, deps);
}
