import { hostname, userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { GUILD_STATE_PREFIX, MESSAGE_CACHE_PREFIX, snowflakeSchema } from '@proton/core';
import {
  countGuildRows,
  countSignInRows,
  type DbHandle,
  deleteGuildRows,
  deleteSignInRows,
  GuildPurgeRefused,
  type GuildRecord,
  type GuildTableCount,
  type SignInRows,
} from '@proton/db';
import { DIRTY_SET_PREFIX } from '@proton/module-giveaways/counter';
import {
  HONEYPOT_CAUGHT_PREFIX,
  HONEYPOT_NOTICE_PREFIX,
  HONEYPOT_STATS_PREFIX,
} from '@proton/module-honeypot/store';
import { JOINROLES_SYNC_PREFIX } from '@proton/module-joinroles/sync-store';
import {
  DM_CHANNEL_PREFIX,
  DRAFT_PREFIX,
  HISTORY_PREFIX,
  PROMPT_SET_PREFIX,
  REACTION_GATE_PREFIX,
} from '@proton/module-moderation';
import { PANEL_PREFIX, QUARANTINE_PREFIX } from '@proton/module-verification/store';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { envSchema } from './env.ts';
import { guildLayoutKey } from './guild-layout.ts';
import { guildCronSchedulerIds, RULE_CRON_QUEUE } from './rule-runtime.ts';

export const guildPurgeEnvSchema = envSchema
  .pick({
    DATABASE_URL: true,
    REDIS_URL: true,
    REDIS_DB_JOBS: true,
    REDIS_DB_STATE: true,
    REDIS_DB_MODULES: true,
    REDIS_DB_MESSAGES: true,
  })
  .extend({ SUDO_USER: z.string().optional() });

export const userPurgeEnvSchema = envSchema
  .pick({ DATABASE_URL: true })
  .extend({ SUDO_USER: z.string().optional() });

export type PurgeRedisDb = 'modules' | 'state' | 'messages';

export interface GuildKeyFamily {
  label: string;
  db: PurgeRedisDb;
  match(guildId: string): string;
}

export const GUILD_KEY_FAMILIES: readonly GuildKeyFamily[] = [
  {
    label: 'verification quarantine records',
    db: 'modules',
    match: (guildId) => `${QUARANTINE_PREFIX}:${guildId}:*`,
  },
  {
    label: 'verification panel',
    db: 'modules',
    match: (guildId) => `${PANEL_PREFIX}:${guildId}`,
  },
  {
    label: 'honeypot notice book',
    db: 'modules',
    match: (guildId) => `${HONEYPOT_NOTICE_PREFIX}:${guildId}`,
  },
  {
    label: 'honeypot counters',
    db: 'modules',
    match: (guildId) => `${HONEYPOT_STATS_PREFIX}:${guildId}:*`,
  },
  {
    label: 'honeypot caught lists',
    db: 'modules',
    match: (guildId) => `${HONEYPOT_CAUGHT_PREFIX}:${guildId}:*`,
  },
  {
    label: 'giveaway counts awaiting a refresh',
    db: 'modules',
    match: (guildId) => `${DIRTY_SET_PREFIX}:${guildId}`,
  },
  {
    label: 'join roles sync records',
    db: 'modules',
    match: (guildId) => `${JOINROLES_SYNC_PREFIX}:*:${guildId}`,
  },
  {
    label: 'moderation forms in progress',
    db: 'modules',
    match: (guildId) => `${DRAFT_PREFIX}:${guildId}:*`,
  },
  {
    label: 'case message history',
    db: 'modules',
    match: (guildId) => `${HISTORY_PREFIX}:${guildId}:*`,
  },
  {
    label: 'report reaction claims',
    db: 'modules',
    match: (guildId) => `${REACTION_GATE_PREFIX}:${guildId}:*`,
  },
  {
    label: 'report prompts awaiting cleanup',
    db: 'modules',
    match: (guildId) => `${PROMPT_SET_PREFIX}:${guildId}`,
  },
  {
    label: 'moderation DM channels',
    db: 'modules',
    match: (guildId) => `${DM_CHANNEL_PREFIX}:${guildId}:*`,
  },
  { label: 'backup layout', db: 'modules', match: guildLayoutKey },
  {
    label: 'cached server details',
    db: 'state',
    match: (guildId) => `${GUILD_STATE_PREFIX}:${guildId}`,
  },
  {
    label: 'remembered message text',
    db: 'messages',
    match: (guildId) => `${MESSAGE_CACHE_PREFIX}:${guildId}:*`,
  },
];

export class PurgeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurgeUsageError';
  }
}

export interface PurgeRequest {
  id: string;
  apply: boolean;
  force: boolean;
}

export function parsePurgeArgs(
  argv: readonly string[],
  what: { noun: string; allowForce: boolean },
): PurgeRequest {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        delete: { type: 'boolean', default: false },
        confirm: { type: 'string' },
        ...(what.allowForce ? { force: { type: 'boolean', default: false } } : {}),
      },
    });
  } catch (error) {
    throw new PurgeUsageError(error instanceof Error ? error.message : String(error));
  }

  const [id, ...extra] = parsed.positionals;
  if (id === undefined || extra.length > 0) {
    throw new PurgeUsageError(`give exactly one ${what.noun} id.`);
  }

  if (!snowflakeSchema.safeParse(id).success) {
    throw new PurgeUsageError(`'${id}' is not a Discord ${what.noun} id.`);
  }

  const apply = parsed.values.delete === true;
  const confirm = parsed.values.confirm;

  if (!apply && confirm !== undefined) {
    throw new PurgeUsageError('--confirm only means something together with --delete.');
  }

  if (apply && confirm === undefined) {
    throw new PurgeUsageError(
      `--delete needs the ${what.noun} id typed a second time: --delete --confirm ${id}`,
    );
  }

  if (apply && confirm !== id) {
    throw new PurgeUsageError(
      `the id after --confirm (${confirm}) is not ${id}, so nothing was deleted.`,
    );
  }

  return { id, apply, force: parsed.values.force === true };
}

export function operatorName(sudoUser: string | undefined): string {
  const who = userInfo().username;
  const via = sudoUser && sudoUser !== who ? ` (via sudo from ${sudoUser})` : '';

  return `${who}${via} on ${hostname()}`;
}

export async function scanKeys(redis: Redis, match: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor = '0';

  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 1000);
    cursor = next;
    for (const key of batch) keys.add(key);
  } while (cursor !== '0');

  return [...keys];
}

async function unlinkAll(redis: Redis, keys: readonly string[]): Promise<number> {
  let removed = 0;
  for (let start = 0; start < keys.length; start += 500) {
    removed += await redis.unlink(...keys.slice(start, start + 500));
  }

  return removed;
}

export interface PurgeOutput {
  print(line: string): void;
  now(): Date;
  operator: string;
}

export interface GuildPurgeDeps extends PurgeOutput {
  handle: DbHandle;
  redis: Record<PurgeRedisDb, Redis>;
  cron: Pick<Queue, 'getBackend' | 'toKey' | 'removeJobScheduler'>;
}

const pad = (text: string, width: number): string => text.padEnd(width);

const field = (label: string, value: string): string => `  ${pad(`${label}:`, 10)}${value}`;

function header(out: PurgeOutput, title: string, apply: boolean, subject: string): void {
  out.print(`${title}: ${apply ? 'DELETING' : 'DRY RUN, nothing will be deleted'}`);
  out.print(field('subject', subject));
  out.print(field('started', out.now().toISOString()));
  out.print(field('operator', out.operator));
}

const finished = (out: PurgeOutput): string =>
  `Finished ${out.now().toISOString()}. Database backups taken before then still hold this ` +
  'data until they are deleted.';

export function describeGuild(guild: GuildRecord | null): string {
  if (!guild) return 'no guilds row: Proton has no record of this server';

  const left = guild.leftAt ? `left ${guild.leftAt.toISOString()}` : 'Proton is still in it';
  return `"${guild.name}", joined ${guild.joinedAt.toISOString()}, ${left}`;
}

export function guildTableLines(tables: readonly GuildTableCount[]): string[] {
  const width = Math.max(...tables.map((table) => table.table.length)) + 2;
  const total = tables.reduce((sum, table) => sum + table.rows, 0);

  return [
    ...tables.map(
      (table) =>
        `  ${pad(table.table, width)}${String(table.rows).padStart(8)}  ${table.removedBy}`,
    ),
    `  ${pad('total', width)}${String(total).padStart(8)}`,
  ];
}

export async function runGuildPurge(deps: GuildPurgeDeps, request: PurgeRequest): Promise<number> {
  header(deps, 'Proton server data purge', request.apply, `server ${request.id}`);

  try {
    return await purgeGuild(deps, request);
  } catch (error) {
    if (!(error instanceof GuildPurgeRefused)) throw error;

    deps.print(`REFUSED: ${error.message}`);
    return 2;
  }
}

async function purgeGuild(deps: GuildPurgeDeps, request: PurgeRequest): Promise<number> {
  const guildId = request.id;
  const found = await countGuildRows(deps.handle, guildId);

  deps.print(field('record', describeGuild(found.guild)));

  const tables = request.apply
    ? (await deleteGuildRows(deps.handle, guildId, { allowPresent: request.force })).tables
    : found.tables;

  deps.print(request.apply ? 'Postgres rows deleted' : 'Postgres rows found');
  for (const line of guildTableLines(tables)) deps.print(line);

  const schedulers = await guildCronSchedulerIds(deps.cron, guildId);
  let removedSchedulers = 0;
  if (request.apply) {
    for (const id of schedulers) {
      if (await deps.cron.removeJobScheduler(id)) removedSchedulers += 1;
    }
  }

  deps.print(request.apply ? 'BullMQ schedulers removed' : 'BullMQ schedulers found');
  deps.print(
    `  ${RULE_CRON_QUEUE}: ${request.apply ? removedSchedulers : schedulers.length}` +
      (schedulers.length > 0 ? ` (${schedulers.join(', ')})` : ''),
  );

  deps.print(request.apply ? 'Redis keys deleted' : 'Redis keys found');
  for (const family of GUILD_KEY_FAMILIES) {
    const redis = deps.redis[family.db];
    const match = family.match(guildId);
    const keys = await scanKeys(redis, match);
    const count = request.apply ? await unlinkAll(redis, keys) : keys.length;

    deps.print(`  ${pad(family.label, 36)}${String(count).padStart(6)}  ${family.db}: ${match}`);
  }

  if (request.apply) {
    deps.print(finished(deps));
    return 0;
  }

  if (found.guild && found.guild.leftAt === null) {
    deps.print(
      'Proton is still in this server, so --delete will be refused unless --force is given.',
    );
  }
  deps.print(`Nothing was deleted. To delete, run again with: --delete --confirm ${guildId}`);
  return 0;
}

export interface UserPurgeDeps extends PurgeOutput {
  handle: DbHandle;
}

export function signInLines(rows: SignInRows, discordUserId: string): string[] {
  return [
    ...rows.users.map((row) => `  user ${row.id}, Discord account ${discordUserId}`),
    `  ${pad('user rows', 14)}${rows.users.length}`,
    `  ${pad('account rows', 14)}${rows.accounts}`,
    `  ${pad('session rows', 14)}${rows.sessions}`,
  ];
}

export async function runUserPurge(deps: UserPurgeDeps, request: PurgeRequest): Promise<number> {
  const discordUserId = request.id;
  header(deps, 'Proton sign-in data purge', request.apply, `Discord user ${discordUserId}`);

  const rows = request.apply
    ? await deleteSignInRows(deps.handle, discordUserId)
    : await countSignInRows(deps.handle, discordUserId);

  if (rows.users.length === 0) {
    deps.print('No sign-in data is stored for this Discord user. Nothing to delete.');
    return 0;
  }

  deps.print(request.apply ? 'Sign-in rows deleted' : 'Sign-in rows found');
  for (const line of signInLines(rows, discordUserId)) deps.print(line);

  if (request.apply) {
    deps.print(finished(deps));
    return 0;
  }

  deps.print(`Nothing was deleted. To delete, run again with: --delete --confirm ${discordUserId}`);
  return 0;
}
