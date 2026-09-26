import { MAX_VOICE_STAY_MS, snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { VOICE_CHECKPOINT_MS, VOICE_PREFIX } from './constants.ts';

export const VOICE_OPEN_PREFIX = `${VOICE_PREFIX}-open`;
export const VOICE_CLOSED_PREFIX = `${VOICE_PREFIX}-closed`;

// Two checkpoints, not one: a run that lands after the session expired loses the capped tail for good.
export const VOICE_SESSION_GRACE_MS = 2 * VOICE_CHECKPOINT_MS;
export const VOICE_TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export const achievementVoiceSessionSchema = z.object({
  channelId: snowflakeSchema,
  joinedAt: z.number().int(),
  startedAt: z.number().int(),
  lastEventAt: z.number().int(),
  temporary: z.boolean(),
});

export type AchievementVoiceSession = z.infer<typeof achievementVoiceSessionSchema>;

export interface OpenVoiceSession {
  userId: string;
  session: AchievementVoiceSession;
}

export interface VoiceAdvance {
  joinedAt?: number;
  lastEventAt?: number;
}

export interface AchievementVoiceStore {
  get(guildId: string, userId: string): Promise<AchievementVoiceSession | null>;
  list(guildId: string): Promise<OpenVoiceSession[]>;
  open(guildId: string, userId: string, session: AchievementVoiceSession): Promise<boolean>;
  advance(
    guildId: string,
    userId: string,
    expectedJoinedAt: number,
    next: VoiceAdvance,
  ): Promise<boolean>;
  close(
    guildId: string,
    userId: string,
    expectedJoinedAt: number,
    closedAt: number,
  ): Promise<boolean>;
  markLeft(guildId: string, userId: string, leftAt: number): Promise<boolean>;
}

export function voiceSessionExpiry(session: Pick<AchievementVoiceSession, 'startedAt'>): number {
  return session.startedAt + MAX_VOICE_STAY_MS + VOICE_SESSION_GRACE_MS;
}

export function achievementVoiceKey(guildId: string, userId: string): string {
  return `${VOICE_PREFIX}:${guildId}:${userId}`;
}

export function achievementVoiceSetKey(guildId: string): string {
  return `${VOICE_OPEN_PREFIX}:${guildId}`;
}

export function achievementVoiceTombstoneKey(guildId: string, userId: string): string {
  return `${VOICE_CLOSED_PREFIX}:${guildId}:${userId}`;
}

const NOW_MS = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;

const OPEN = `${NOW_MS}
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local expires = tonumber(ARGV[3])
if expires <= now then return 0 end
local closed = redis.call('GET', KEYS[3])
if closed and tonumber(closed) and tonumber(closed) >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
local ttl = redis.call('PTTL', KEYS[2])
if ttl < 0 or now + ttl < expires then redis.call('PEXPIREAT', KEYS[2], ARGV[3]) end
return 1
`;

const ADVANCE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, session = pcall(cjson.decode, raw)
if not ok or type(session) ~= 'table' then return 0 end
if session.joinedAt ~= tonumber(ARGV[1]) then return 0 end
if ARGV[2] ~= '' then session.joinedAt = tonumber(ARGV[2]) end
if ARGV[3] ~= '' and tonumber(ARGV[3]) > session.lastEventAt then
  session.lastEventAt = tonumber(ARGV[3])
end
redis.call('SET', KEYS[1], cjson.encode(session), 'KEEPTTL')
return 1
`;

const CLOSE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, session = pcall(cjson.decode, raw)
local valid = ok and type(session) == 'table'
if valid and session.joinedAt ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[3])
local mark = tonumber(ARGV[2])
if valid and type(session.lastEventAt) == 'number' and session.lastEventAt > mark then
  mark = session.lastEventAt
end
local previous = tonumber(redis.call('GET', KEYS[3]) or '')
if previous and previous > mark then mark = previous end
redis.call('SET', KEYS[3], string.format('%d', mark), 'PX', ARGV[4])
return 1
`;

const MARK_LEFT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local mark = tonumber(ARGV[1])
local previous = tonumber(redis.call('GET', KEYS[2]) or '')
if previous and previous > mark then mark = previous end
redis.call('SET', KEYS[2], string.format('%d', mark), 'PX', ARGV[2])
return 1
`;

const FORGET_MISSING = `
local removed = 0
for index, userId in ipairs(ARGV) do
  if redis.call('EXISTS', KEYS[index + 1]) == 0 then
    removed = removed + redis.call('SREM', KEYS[1], userId)
  end
end
return removed
`;

function parse(raw: string | null | undefined): AchievementVoiceSession | null {
  if (raw === null || raw === undefined) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = achievementVoiceSessionSchema.safeParse(value);
  return result.success ? result.data : null;
}

export class RedisAchievementVoiceStore implements AchievementVoiceStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async get(guildId: string, userId: string): Promise<AchievementVoiceSession | null> {
    return parse(await this.#redis.get(achievementVoiceKey(guildId, userId)));
  }

  async list(guildId: string): Promise<OpenVoiceSession[]> {
    const userIds = (await this.#redis.smembers(achievementVoiceSetKey(guildId))).sort();
    if (userIds.length === 0) return [];

    const raws = await this.#redis.mget(
      ...userIds.map((userId) => achievementVoiceKey(guildId, userId)),
    );

    const open: OpenVoiceSession[] = [];
    const missing: string[] = [];

    userIds.forEach((userId, index) => {
      const raw = raws[index];
      const session = parse(raw);
      if (session) open.push({ userId, session });
      else if (raw === null || raw === undefined) missing.push(userId);
    });

    if (missing.length > 0) {
      await this.#redis.eval(
        FORGET_MISSING,
        missing.length + 1,
        achievementVoiceSetKey(guildId),
        ...missing.map((userId) => achievementVoiceKey(guildId, userId)),
        ...missing,
      );
    }

    return open;
  }

  async open(guildId: string, userId: string, session: AchievementVoiceSession): Promise<boolean> {
    const opened = await this.#redis.eval(
      OPEN,
      3,
      achievementVoiceKey(guildId, userId),
      achievementVoiceSetKey(guildId),
      achievementVoiceTombstoneKey(guildId, userId),
      JSON.stringify(achievementVoiceSessionSchema.parse(session)),
      session.lastEventAt,
      voiceSessionExpiry(session),
      userId,
    );

    return Number(opened) === 1;
  }

  async advance(
    guildId: string,
    userId: string,
    expectedJoinedAt: number,
    next: VoiceAdvance,
  ): Promise<boolean> {
    const advanced = await this.#redis.eval(
      ADVANCE,
      1,
      achievementVoiceKey(guildId, userId),
      expectedJoinedAt,
      next.joinedAt ?? '',
      next.lastEventAt ?? '',
    );

    return Number(advanced) === 1;
  }

  async close(
    guildId: string,
    userId: string,
    expectedJoinedAt: number,
    closedAt: number,
  ): Promise<boolean> {
    const closed = await this.#redis.eval(
      CLOSE,
      3,
      achievementVoiceKey(guildId, userId),
      achievementVoiceSetKey(guildId),
      achievementVoiceTombstoneKey(guildId, userId),
      expectedJoinedAt,
      closedAt,
      userId,
      VOICE_TOMBSTONE_TTL_MS,
    );

    return Number(closed) === 1;
  }

  async markLeft(guildId: string, userId: string, leftAt: number): Promise<boolean> {
    const marked = await this.#redis.eval(
      MARK_LEFT,
      2,
      achievementVoiceKey(guildId, userId),
      achievementVoiceTombstoneKey(guildId, userId),
      leftAt,
      VOICE_TOMBSTONE_TTL_MS,
    );

    return Number(marked) === 1;
  }
}
