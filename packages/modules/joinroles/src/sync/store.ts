import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  isStaleRun,
  type LastSync,
  lastSyncSchema,
  type SyncEstimate,
  type SyncRun,
  syncEstimateSchema,
  syncRunSchema,
} from './view.ts';

export const JOINROLES_SYNC_PREFIX = 'proton:joinroles:sync';

export const SYNC_RUN_TTL_SECONDS = 24 * 60 * 60;
export const SYNC_LAST_TTL_SECONDS = 180 * 24 * 60 * 60;
export const SYNC_ESTIMATE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SYNC_AUTOSYNC_TTL_SECONDS = 8 * 24 * 60 * 60;

export type SyncKeyPart = 'run' | 'last' | 'estimate' | 'autosync';

const autosyncAtSchema = z.number().int().nonnegative();

export function joinrolesSyncKey(
  part: SyncKeyPart,
  guildId: string,
  prefix: string = JOINROLES_SYNC_PREFIX,
): string {
  return `${prefix}:${part}:${guildId}`;
}

export interface SyncFinish {
  last?: LastSync;
  estimate?: SyncEstimate;
}

export interface JoinRolesRunStore {
  get(guildId: string): Promise<SyncRun | null>;
  claim(run: SyncRun): Promise<boolean>;
  putIfCurrent(run: SyncRun): Promise<boolean>;
  clear(guildId: string, runId: string): Promise<boolean>;
  finish(guildId: string, runId: string, result: SyncFinish): Promise<boolean>;
  last(guildId: string): Promise<LastSync | null>;
  estimate(guildId: string): Promise<SyncEstimate | null>;
  autosyncAt(guildId: string): Promise<number | null>;
  setAutosyncAt(guildId: string, at: number): Promise<void>;
}

export type SyncClaim =
  | { claimed: true; replaced: SyncRun | null }
  | { claimed: false; current: SyncRun | null };

export async function claimRun(
  runs: Pick<JoinRolesRunStore, 'claim' | 'get' | 'clear'>,
  run: SyncRun,
  now: number,
): Promise<SyncClaim> {
  if (await runs.claim(run)) return { claimed: true, replaced: null };

  const current = await runs.get(run.guildId);
  if (current === null || current.runId === run.runId || !isStaleRun(current, now)) {
    return { claimed: false, current };
  }

  if ((await runs.clear(run.guildId, current.runId)) && (await runs.claim(run))) {
    return { claimed: true, replaced: current };
  }

  return { claimed: false, current: await runs.get(run.guildId) };
}

const CURRENT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or type(decoded) ~= 'table' or decoded.runId ~= ARGV[1] then return 0 end
`;

const PUT_IF_CURRENT = `${CURRENT}
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

const CLEAR = `${CURRENT}
redis.call('DEL', KEYS[1])
return 1
`;

const FINISH = `${CURRENT}
if ARGV[2] ~= '' then redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) end
if ARGV[4] ~= '' then redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5]) end
redis.call('DEL', KEYS[1])
return 1
`;

function decode<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export class RedisJoinRolesRunStore implements JoinRolesRunStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { prefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? JOINROLES_SYNC_PREFIX;
  }

  #key(part: SyncKeyPart, guildId: string): string {
    return joinrolesSyncKey(part, guildId, this.#prefix);
  }

  async get(guildId: string): Promise<SyncRun | null> {
    return decode(await this.#redis.get(this.#key('run', guildId)), syncRunSchema);
  }

  async claim(run: SyncRun): Promise<boolean> {
    const set = await this.#redis.set(
      this.#key('run', run.guildId),
      JSON.stringify(run),
      'EX',
      SYNC_RUN_TTL_SECONDS,
      'NX',
    );
    return set === 'OK';
  }

  async putIfCurrent(run: SyncRun): Promise<boolean> {
    const written = await this.#redis.eval(
      PUT_IF_CURRENT,
      1,
      this.#key('run', run.guildId),
      run.runId,
      JSON.stringify(run),
      SYNC_RUN_TTL_SECONDS,
    );
    return Number(written) === 1;
  }

  async clear(guildId: string, runId: string): Promise<boolean> {
    const cleared = await this.#redis.eval(CLEAR, 1, this.#key('run', guildId), runId);
    return Number(cleared) === 1;
  }

  async finish(guildId: string, runId: string, result: SyncFinish): Promise<boolean> {
    const finished = await this.#redis.eval(
      FINISH,
      3,
      this.#key('run', guildId),
      this.#key('last', guildId),
      this.#key('estimate', guildId),
      runId,
      result.last ? JSON.stringify(result.last) : '',
      SYNC_LAST_TTL_SECONDS,
      result.estimate ? JSON.stringify(result.estimate) : '',
      SYNC_ESTIMATE_TTL_SECONDS,
    );
    return Number(finished) === 1;
  }

  async last(guildId: string): Promise<LastSync | null> {
    return decode(await this.#redis.get(this.#key('last', guildId)), lastSyncSchema);
  }

  async estimate(guildId: string): Promise<SyncEstimate | null> {
    return decode(await this.#redis.get(this.#key('estimate', guildId)), syncEstimateSchema);
  }

  async autosyncAt(guildId: string): Promise<number | null> {
    return decode(await this.#redis.get(this.#key('autosync', guildId)), autosyncAtSchema);
  }

  async setAutosyncAt(guildId: string, at: number): Promise<void> {
    await this.#redis.set(
      this.#key('autosync', guildId),
      JSON.stringify(at),
      'EX',
      SYNC_AUTOSYNC_TTL_SECONDS,
    );
  }
}
