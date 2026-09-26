import { createHash } from 'node:crypto';
import type { Causation, GuildState, ModuleContext, XpSource } from '@proton/core';
import { ChannelType } from 'discord-api-types/v10';
import { type ActivityRecord, activityRecordSchema } from '../activity.ts';
import { type AchievementsConfig, MODULE_ID, type Requirement } from '../config.ts';
import { type AchievementsDeps, type ChannelKind, clockOf, describeUnbound } from '../deps.ts';
import {
  type EvaluateInput,
  evaluateMember,
  type ProcessInput,
  processRecords,
  type SubjectFacts,
} from '../engine.ts';
import { acceptsAt } from '../evaluate.ts';
import type { AchievementStore } from '../store.ts';
import type { LedgerMetric } from '../triggers.ts';

export type Ctx = ModuleContext<AchievementsConfig>;

export interface CollectorEngine {
  processRecords(ctx: Ctx, deps: AchievementsDeps, input: ProcessInput): Promise<void>;
  evaluateMember(ctx: Ctx, deps: AchievementsDeps, input: EvaluateInput): Promise<void>;
}

export const ENGINE: CollectorEngine = { processRecords, evaluateMember };

export const DISCORD_SOURCE = 'discord';

const KEY_MAX = 200;
const DEPTH_CEILING = 32;
const CHANNEL_KIND_TTL_MS = 10 * 60 * 1000;

class Lru<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();
  readonly #max: number;
  readonly #ttlMs: number;

  constructor(max: number, ttlMs = Number.POSITIVE_INFINITY) {
    this.#max = max;
    this.#ttlMs = ttlMs;
  }

  get(key: string, now: number): { value: V } | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;

    this.#entries.delete(key);
    if (entry.expiresAt <= now) return undefined;

    this.#entries.set(key, entry);
    return { value: entry.value };
  }

  set(key: string, value: V, now: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + this.#ttlMs });

    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }
}

interface KnownFacts {
  joinedAt?: number | null;
  premiumSince?: number | null;
}

interface CollectorCaches {
  channelKinds: Lru<ChannelKind | null>;
  facts: Lru<KnownFacts>;
  activeDays: Lru<true>;
  reactions: Lru<string>;
}

const CACHES = new WeakMap<AchievementsDeps, CollectorCaches>();

export function cachesOf(deps: AchievementsDeps): CollectorCaches {
  let caches = CACHES.get(deps);
  if (!caches) {
    caches = {
      channelKinds: new Lru(5_000, CHANNEL_KIND_TTL_MS),
      facts: new Lru(50_000),
      activeDays: new Lru(50_000),
      reactions: new Lru(20_000),
    };
    CACHES.set(deps, caches);
  }
  return caches;
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function own(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

export function text(value: unknown, key: string): string | null {
  const held = own(value, key);
  return typeof held === 'string' ? held : null;
}

export function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  const held = own(value, key);
  return typeof held === 'object' && held !== null ? (held as Record<string, unknown>) : null;
}

export function instantOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export interface MemberPayload {
  present: boolean;
  roleIds: string[] | null;
  joinedAt: number | null | undefined;
  premiumSince: number | null | undefined;
}

export function readMember(member: unknown): MemberPayload {
  if (typeof member !== 'object' || member === null) {
    return { present: false, roleIds: null, joinedAt: undefined, premiumSince: undefined };
  }

  const roles = own(member, 'roles');
  return {
    present: true,
    roleIds: Array.isArray(roles)
      ? roles.filter((role): role is string => typeof role === 'string')
      : null,
    joinedAt: instantOf(own(member, 'joined_at')),
    premiumSince: instantOf(own(member, 'premium_since')),
  };
}

export function subjectOf(member: MemberPayload, isBot: boolean | null): SubjectFacts {
  return { roleIds: member.roleIds, isMember: member.present ? true : null, isBot };
}

export function snowflakeTime(id: string): number | null {
  try {
    return Number(BigInt(id) >> 22n) + 1_420_070_400_000;
  } catch {
    return null;
  }
}

export function isProton(deps: AchievementsDeps, userId: string): boolean {
  return userId === deps.botUserId || userId === deps.applicationId;
}

export function organicCausation(eventId: string): Causation {
  return { kind: 'organic', rootId: eventId.slice(0, KEY_MAX), depth: 0 };
}

export function continuedCausation(causation: Causation): Causation {
  return { ...causation, depth: Math.min(causation.depth + 1, DEPTH_CEILING) };
}

export function boundedKey(key: string): string {
  if (key.length <= KEY_MAX) return key;
  return `${key.slice(0, 150)}#${createHash('sha1').update(key).digest('hex')}`;
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = DAY_FORMATS.get(timeZone);
  if (cached) return cached;

  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }

  DAY_FORMATS.set(timeZone, format);
  return format;
}

export function dayKey(at: number, timeZone: string): string {
  const parts = dayFormat(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export interface Chain {
  channelId: string | null;
  parentId: string | null;
  categoryId: string | null;
}

export const NO_CHANNEL: Chain = { channelId: null, parentId: null, categoryId: null };

export async function guildStateOf(
  ctx: Ctx,
  deps: AchievementsDeps,
  guildId: string,
): Promise<GuildState | null> {
  if (!deps.guildState) return null;

  try {
    return await deps.guildState.get(guildId);
  } catch (error) {
    ctx.logger.warn(
      `achievements could not read the channels of server ${guildId}, so an exclusion set on a ` +
        `parent channel or category did not apply to this activity: ${reasonOf(error)}`,
      { guildId, moduleId: MODULE_ID },
    );
    return null;
  }
}

export function chainOf(channelId: string, guild: GuildState | null): Chain {
  const parentId = guild?.channels.get(channelId)?.parentId ?? null;
  if (parentId === null || parentId === channelId) {
    return { channelId, parentId: null, categoryId: null };
  }

  const parent = guild?.channels.get(parentId);
  if (parent?.type === ChannelType.GuildCategory) {
    return { channelId, parentId: null, categoryId: parentId };
  }

  const grandparentId = parent?.parentId ?? null;
  return {
    channelId,
    parentId,
    categoryId:
      grandparentId === null || grandparentId === channelId || grandparentId === parentId
        ? null
        : grandparentId,
  };
}

export function chainIds(chain: Chain): string[] {
  return [chain.channelId, chain.parentId, chain.categoryId].filter(
    (id): id is string => id !== null,
  );
}

export function excludedChain(config: AchievementsConfig, chain: Chain): boolean {
  return chainIds(chain).some((id) => config.excludedChannelIds.includes(id));
}

export function excludedByRole(
  config: AchievementsConfig,
  roleIds: readonly string[] | null,
): boolean {
  return roleIds?.some((roleId) => config.excludedRoleIds.includes(roleId)) ?? false;
}

export async function channelKindOf(
  deps: AchievementsDeps,
  guildId: string,
  channelId: string,
): Promise<ChannelKind | null> {
  if (!deps.channelKind) return null;

  const caches = cachesOf(deps);
  const now = clockOf(deps)();
  const cacheKey = `${guildId}:${channelId}`;

  const hit = caches.channelKinds.get(cacheKey, now);
  if (hit) return hit.value;

  const kind = await deps.channelKind(guildId, channelId);
  caches.channelKinds.set(cacheKey, kind, now);
  return kind;
}

export async function isTicketChain(
  deps: AchievementsDeps,
  guildId: string,
  chain: Chain,
): Promise<boolean> {
  for (const channelId of [chain.channelId, chain.parentId]) {
    if (channelId !== null && (await channelKindOf(deps, guildId, channelId)) === 'ticket') {
      return true;
    }
  }
  return false;
}

export async function locate(
  ctx: Ctx,
  deps: AchievementsDeps,
  guildId: string,
  channelId: string,
): Promise<Chain | null> {
  const chain = chainOf(channelId, await guildStateOf(ctx, deps, guildId));
  if (excludedChain(ctx.config, chain)) return null;
  if (await isTicketChain(deps, guildId, chain)) return null;
  return chain;
}

export function storeOf(ctx: Ctx, deps: AchievementsDeps, what: string): AchievementStore | null {
  if (deps.store) return deps.store;
  ctx.logger.error(describeUnbound(what, ['store']), { guildId: ctx.guildId, moduleId: MODULE_ID });
  return null;
}

export interface RecordFields {
  userId: string;
  metric: LedgerMetric;
  sourceKey: string;
  occurredAt: number;
  sourceModule: string;
  causation: Causation;
  amount?: number;
  spanStart?: number | null;
  chain?: Chain;
  temporary?: boolean;
  xpSource?: XpSource | null;
  groupKey?: string | null;
  pending?: boolean;
}

export function activityRecord(ctx: Ctx, fields: RecordFields): ActivityRecord | null {
  const chain = fields.chain ?? NO_CHANNEL;
  const parsed = activityRecordSchema.safeParse({
    guildId: ctx.guildId,
    userId: fields.userId,
    metric: fields.metric,
    sourceKey: boundedKey(fields.sourceKey),
    occurredAt: fields.occurredAt,
    spanStart: fields.spanStart ?? null,
    amount: fields.amount ?? 1,
    channelId: chain.channelId,
    parentId: chain.parentId,
    categoryId: chain.categoryId,
    temporary: fields.temporary ?? false,
    xpSource: fields.xpSource ?? null,
    groupKey: fields.groupKey ?? null,
    pending: fields.pending ?? false,
    sourceModule: fields.sourceModule,
    causation: fields.causation,
  });

  if (!parsed.success) {
    ctx.logger.warn(
      `achievements did not count ${fields.metric} for ${fields.userId}: the activity it read ` +
        `was malformed (${parsed.error.message})`,
      { guildId: ctx.guildId, moduleId: MODULE_ID, sourceKey: fields.sourceKey },
    );
    return null;
  }

  return parsed.data;
}

export function validRecords(ctx: Ctx, records: readonly ActivityRecord[]): ActivityRecord[] {
  return records.flatMap((record) => {
    const parsed = activityRecordSchema.safeParse(record);
    if (parsed.success) return [parsed.data];

    ctx.logger.warn(
      `achievements did not re-run ${record.metric} ${record.sourceKey} for ${record.userId}: ` +
        `the stored activity was malformed (${parsed.error.message})`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return [];
  });
}

export function activeDayRecord(
  ctx: Ctx,
  deps: AchievementsDeps,
  fields: Omit<RecordFields, 'metric' | 'sourceKey'>,
): { record: ActivityRecord; mark: string } | null {
  const day = dayKey(fields.occurredAt, ctx.config.timezone);
  const now = clockOf(deps)();
  const counting = ctx.config.achievements
    .filter(
      (achievement) =>
        achievement.status === 'active' &&
        achievement.requirements.some(
          (requirement) => requirement.trigger === 'activity.active_days',
        ) &&
        acceptsAt(achievement, fields.occurredAt, now),
    )
    .map((achievement) => achievement.id);

  // Marked per counting achievement: one activated later the same day must still be offered that day.
  const mark = `${ctx.guildId}:${fields.userId}:${day}:${counting.join(',')}`;
  if (cachesOf(deps).activeDays.get(mark, now)) return null;

  const record = activityRecord(ctx, {
    ...fields,
    metric: 'active_days',
    sourceKey: `${fields.userId}:${day}`,
  });
  return record ? { record, mark } : null;
}

export function markActiveDays(deps: AchievementsDeps, marks: readonly string[]): void {
  const caches = cachesOf(deps);
  const now = clockOf(deps)();
  for (const mark of marks) caches.activeDays.set(mark, true, now);
}

export async function rememberFacts(
  deps: AchievementsDeps,
  store: AchievementStore,
  guildId: string,
  userId: string,
  member: MemberPayload,
): Promise<void> {
  if (!member.present) return;

  const incoming: KnownFacts = {
    ...(member.joinedAt === undefined || member.joinedAt === null
      ? {}
      : { joinedAt: member.joinedAt }),
    ...(member.premiumSince === undefined ? {} : { premiumSince: member.premiumSince }),
  };
  if (incoming.joinedAt === undefined && incoming.premiumSince === undefined) return;

  const caches = cachesOf(deps);
  const now = clockOf(deps)();
  const cacheKey = `${guildId}:${userId}`;
  const known = caches.facts.get(cacheKey, now)?.value;

  if (
    known &&
    (incoming.joinedAt === undefined || known.joinedAt === incoming.joinedAt) &&
    (incoming.premiumSince === undefined || known.premiumSince === incoming.premiumSince)
  ) {
    return;
  }

  await store.upsertFacts(guildId, userId, { ...incoming, leftAt: null });
  caches.facts.set(cacheKey, { ...known, ...incoming }, now);
}

export function forgetFacts(deps: AchievementsDeps, guildId: string, userId: string): void {
  cachesOf(deps).facts.delete(`${guildId}:${userId}`);
}

export interface Batch {
  records: ActivityRecord[];
  subjects?: ReadonlyMap<string, SubjectFacts>;
  originChannelId: string | null;
  onRecorded?: (record: ActivityRecord) => Promise<void>;
}

export async function submit(
  ctx: Ctx,
  deps: AchievementsDeps,
  engine: CollectorEngine,
  batch: Batch,
): Promise<void> {
  if (batch.records.length === 0) return;

  await engine.processRecords(ctx, deps, {
    records: batch.records,
    ...(batch.subjects ? { subjects: batch.subjects } : {}),
    ...(batch.onRecorded ? { onRecorded: batch.onRecorded } : {}),
    originChannelId: batch.originChannelId,
  });
}

export function activeUsing(
  config: AchievementsConfig,
  uses: (requirement: Requirement) => boolean,
): string[] {
  return config.achievements
    .filter((achievement) => achievement.status === 'active' && achievement.requirements.some(uses))
    .map((achievement) => achievement.id);
}

export function mismatchedGuild(ctx: Ctx, guildId: string, what: string, eventId: string): boolean {
  if (guildId === ctx.guildId) return false;

  ctx.logger.warn(
    `achievements ignored ${what}: it names server ${guildId} but arrived for this one`,
    { guildId: ctx.guildId, moduleId: MODULE_ID, eventId },
  );
  return true;
}

export function unreadable(ctx: Ctx, what: string, eventId: string, message: string): void {
  ctx.logger.warn(`achievements ignored ${what} it could not read: ${message}`, {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    eventId,
  });
}
