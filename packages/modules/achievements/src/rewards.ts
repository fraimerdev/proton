import { TIER_LABELS } from '@proton/cards/design';
import {
  type AchievementRetryResult,
  type AchievementRetryStatus,
  type AchievementRewardRef,
  type ActionFailure,
  type Causation,
  type GuildState,
  isScopedActionExecutor,
  type ModuleContext,
  roleGrantRefusal,
  type TierId,
  xpGrantRequestedSchema,
} from '@proton/core';
import { type AchievementsConfig, MODULE_ID } from './config.ts';
import { ACHIEVEMENTS_ACTOR, MAX_REWARD_ATTEMPTS } from './constants.ts';
import { type AchievementsDeps, clockOf } from './deps.ts';
import { tierRank } from './evaluate.ts';
import {
  type AchievementStore,
  CANCELLED_BY_RESET,
  type RewardOutcome,
  type RewardRef,
  type RewardRow,
  type UnlockRow,
  xpGrantId,
} from './store.ts';

type Context = ModuleContext<AchievementsConfig>;

type RoleKind = 'add_role' | 'remove_role';

type Finish = (outcome: Omit<RewardOutcome, 'now'>) => Promise<boolean>;

export const ROLE_REWARD_LEASE_MS = 60 * 1000;

export const REWARD_BACKOFF_MS = [
  30 * 1000,
  2 * 60 * 1000,
  10 * 60 * 1000,
  60 * 60 * 1000,
] as const;

export const RANKED_TARGET =
  'Proton doesn’t give roles to the server owner or members ranked at or above Proton.';

const RANKED_TARGET_REMOVAL =
  'Proton doesn’t remove roles from the server owner or members ranked at or above Proton.';

export const ROLE_UNCONFIRMED = 'Couldn’t confirm the role change. Proton will try again.';

export const XP_UNCONFIRMED = 'Leveling didn’t confirm the XP reward.';

const ROLE_UNFINISHED = `Proton couldn’t finish this role change after ${MAX_REWARD_ATTEMPTS} tries.`;

const NOT_A_MEMBER = 'They’re no longer a member of this server.';

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'guild_state_unavailable',
  'target_state_unavailable',
  'transport_failure',
]);

const PERMANENT_DISCORD_CODES: ReadonlySet<number> = new Set([10007, 10011, 50013]);

const KIND_ORDER: Readonly<Record<RewardRow['kind'], number>> = {
  remove_role: 0,
  add_role: 1,
  xp: 2,
};

const COUNT = new Intl.NumberFormat('en-GB');

export function levelingOffReason(amount: number): string {
  return (
    `Leveling is off in this server, so the ${COUNT.format(amount)} XP reward wasn’t given. ` +
    'Turn Leveling on, then retry.'
  );
}

export function isTransientFailure(failure: ActionFailure): boolean {
  if (TRANSIENT_CODES.has(failure.code)) return true;
  if (failure.discordCode !== undefined && PERMANENT_DISCORD_CODES.has(failure.discordCode)) {
    return false;
  }

  const status = /^discord_(\d{3})$/.exec(failure.code)?.[1];
  if (status === undefined) return false;

  const code = Number(status);
  return code === 429 || code >= 500;
}

export function rewardBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), REWARD_BACKOFF_MS.length) - 1;
  return REWARD_BACKOFF_MS[index] ?? REWARD_BACKOFF_MS[0];
}

export function isSettled(row: RewardRow): boolean {
  return (
    row.status === 'delivered' ||
    row.status === 'skipped' ||
    row.status === 'cancelled' ||
    (row.status === 'failed' && !row.transient)
  );
}

export function rewardSlot(row: Pick<RewardRow, 'tierId' | 'rewardKey'>): string {
  return `${row.tierId}:${row.rewardKey}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refOf(guildId: string, row: RewardRow): RewardRef {
  return {
    guildId,
    userId: row.userId,
    achievementId: row.achievementId,
    tierId: row.tierId,
    generation: row.generation,
    rewardKey: row.rewardKey,
  };
}

function leaseOver(row: RewardRow, now: number): boolean {
  return row.leaseUntil === null || row.leaseUntil <= now;
}

function due(row: RewardRow, now: number, manual: boolean): boolean {
  switch (row.status) {
    case 'pending':
      return true;
    case 'failed':
      return manual || (row.transient && (row.nextAttemptAt === null || row.nextAttemptAt <= now));
    case 'delivering':
    case 'requested':
      return leaseOver(row, now);
    default:
      return false;
  }
}

function byDelivery(a: RewardRow, b: RewardRow): number {
  return (
    tierRank(a.tierId) - tierRank(b.tierId) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.rewardKey.localeCompare(b.rewardKey)
  );
}

interface Intent {
  kind: RoleKind;
  tierId: TierId;
}

// Every row of the generation, settled or not: a retried Bronze reward must never undo Silver’s.
function intentOf(rows: readonly RewardRow[]): Map<string, Intent> {
  const intent = new Map<string, Intent>();

  for (const row of [...rows].sort(byDelivery)) {
    if (row.kind === 'xp' || row.roleId === null) continue;
    intent.set(row.roleId, { kind: row.kind, tierId: row.tierId });
  }

  return intent;
}

interface Lookups {
  guildState(): Promise<GuildState | null>;
  moduleOn(moduleId: string): Promise<boolean>;
  unlock(row: RewardRow): Promise<UnlockRow | null>;
  label(row: RewardRow): Promise<string>;
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load();
    return loaded;
  };
}

function lookupsFor(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  userId: string,
): Lookups {
  const guildState = memo(async () => {
    if (!deps.guildState) return null;
    try {
      return await deps.guildState.get(ctx.guildId);
    } catch (error) {
      ctx.logger.warn(
        'achievements could not read the guild-state cache, so reward roles go to Discord ' +
          `without Proton’s own checks: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return null;
    }
  });

  const modules = new Map<string, Promise<boolean>>();
  const moduleOn = (moduleId: string): Promise<boolean> => {
    const cached = modules.get(moduleId);
    if (cached) return cached;

    const availability = deps.availability;
    const answer = availability
      ? availability.isEnabled(ctx.guildId, moduleId).catch((error: unknown) => {
          ctx.logger.warn(
            `achievements could not tell whether ${moduleId} is on, so it assumed it is: ` +
              reasonOf(error),
            { guildId: ctx.guildId, moduleId: MODULE_ID },
          );
          return true;
        })
      : Promise.resolve(true);

    modules.set(moduleId, answer);
    return answer;
  };

  const unlocks = memo(() => store.unlocksOf(ctx.guildId, userId));

  const unlock = async (row: RewardRow): Promise<UnlockRow | null> =>
    (await unlocks()).find(
      (candidate) =>
        candidate.achievementId === row.achievementId &&
        candidate.tierId === row.tierId &&
        candidate.generation === row.generation,
    ) ?? null;

  const label = async (row: RewardRow): Promise<string> => {
    const configured = ctx.config.achievements.find(({ id }) => id === row.achievementId)?.name;
    const name = configured ?? (await unlock(row))?.definition.name ?? row.achievementId;
    return row.tierId === 'single' ? name : `${name} (${TIER_LABELS[row.tierId]})`;
  };

  return { guildState, moduleOn, unlock, label };
}

export interface RewardDelivery {
  userId: string;
  achievementId: string;
  generation: number;
  roleIds?: readonly string[] | null | undefined;
  causation?: Causation | undefined;
  originChannelId?: string | null | undefined;
  only?: ReadonlySet<string> | undefined;
  manual?: boolean | undefined;
}

export async function deliverRewards(
  ctx: Context,
  deps: AchievementsDeps,
  input: RewardDelivery,
): Promise<RewardRow[]> {
  const store = deps.store;
  if (!store) return [];

  const clock = clockOf(deps);
  const manual = input.manual === true;
  const rows = await store.rewardsFor(
    ctx.guildId,
    input.userId,
    input.achievementId,
    input.generation,
  );

  const intent = intentOf(rows);
  const lookups = lookupsFor(ctx, deps, store, input.userId);
  let touched = false;

  for (const row of [...rows].sort(byDelivery)) {
    if (input.only && !input.only.has(rewardSlot(row))) continue;
    if (!due(row, clock(), manual)) continue;

    await deliverOne(ctx, deps, store, row, intent, lookups, input);
    touched = true;
  }

  return touched
    ? store.rewardsFor(ctx.guildId, input.userId, input.achievementId, input.generation)
    : rows;
}

async function deliverOne(
  ctx: Context,
  deps: AchievementsDeps,
  store: AchievementStore,
  row: RewardRow,
  intent: ReadonlyMap<string, Intent>,
  lookups: Lookups,
  input: RewardDelivery,
): Promise<void> {
  const clock = clockOf(deps);
  const now = clock();
  const ref = refOf(ctx.guildId, row);
  const manual = input.manual === true;

  const claim = await store.claimReward(
    ref,
    now,
    ROLE_REWARD_LEASE_MS,
    manual ? { manual: true } : undefined,
  );

  if (!claim) {
    const abandoned =
      !manual &&
      (row.status === 'delivering' || row.status === 'requested') &&
      leaseOver(row, now) &&
      row.attempts >= MAX_REWARD_ATTEMPTS;

    if (abandoned) {
      await store.finishReward(ref, row.attempts, {
        status: 'failed',
        errorCode: 'unconfirmed',
        error: row.kind === 'xp' ? XP_UNCONFIRMED : ROLE_UNFINISHED,
        now,
      });
    }
    return;
  }

  const finish: Finish = (outcome) =>
    store.finishReward(ref, claim.token, { ...outcome, now: clock() });

  if (claim.row.kind === 'xp') {
    await deliverXp(ctx, claim.row, lookups, input, finish);
    return;
  }

  const roleId = claim.row.roleId;
  if (roleId === null) {
    await finish({
      status: 'failed',
      errorCode: 'invalid_reward',
      error: 'This role reward names no role, so there is nothing to give.',
    });
    return;
  }

  const wanted = intent.get(roleId);
  if (wanted && wanted.kind !== claim.row.kind) {
    await finish({
      status: 'skipped',
      errorCode: 'replaced',
      error: `Replaced by ${TIER_LABELS[wanted.tierId]}’s reward.`,
    });
    return;
  }

  await deliverRole(
    ctx,
    deps,
    claim.row,
    claim.row.kind,
    roleId,
    claim.token,
    lookups,
    input,
    finish,
  );
}

function failureOutcome(
  failure: ActionFailure,
  kind: RoleKind,
  attempts: number,
  now: number,
): Omit<RewardOutcome, 'now'> {
  if (isTransientFailure(failure)) {
    return {
      status: 'failed',
      transient: true,
      errorCode: failure.code,
      error: failure.humanReason,
      nextAttemptAt: now + rewardBackoffMs(attempts),
    };
  }

  // The executor refuses the member, not the role, when it doesn't name the role.
  const ranked =
    failure.code === 'target_is_owner' ||
    (failure.code === 'role_hierarchy' && !failure.humanReason.includes('<@&'));

  return {
    status: 'failed',
    errorCode: failure.code,
    error: ranked
      ? kind === 'add_role'
        ? RANKED_TARGET
        : RANKED_TARGET_REMOVAL
      : failure.humanReason,
  };
}

async function confirmRole(
  ctx: Context,
  deps: AchievementsDeps,
  row: RewardRow,
  kind: RoleKind,
  roleId: string,
  attempts: number,
): Promise<Omit<RewardOutcome, 'now'>> {
  const now = clockOf(deps)();
  let member: Awaited<ReturnType<NonNullable<AchievementsDeps['memberFacts']>>> | undefined;

  try {
    member = deps.memberFacts ? await deps.memberFacts(ctx.guildId, row.userId) : undefined;
  } catch (error) {
    ctx.logger.warn(
      `achievements could not read ${row.userId}’s roles to confirm a reward: ${reasonOf(error)}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }

  if (member === null) {
    return { status: 'failed', errorCode: 'target_not_member', error: NOT_A_MEMBER };
  }

  if (member !== undefined && member.roleIds.includes(roleId) === (kind === 'add_role')) {
    return { status: 'delivered' };
  }

  return {
    status: 'failed',
    transient: true,
    errorCode: 'unconfirmed',
    error: ROLE_UNCONFIRMED,
    nextAttemptAt: now + rewardBackoffMs(attempts),
  };
}

async function deliverRole(
  ctx: Context,
  deps: AchievementsDeps,
  row: RewardRow,
  kind: RoleKind,
  roleId: string,
  token: number,
  lookups: Lookups,
  input: RewardDelivery,
  finish: Finish,
): Promise<void> {
  const state = await lookups.guildState();
  const refusal = state ? roleGrantRefusal(state, roleId) : null;

  if (refusal && (refusal.code === 'everyone' || refusal.code === 'managed')) {
    await finish({
      status: 'failed',
      errorCode: refusal.code,
      error: `Proton can’t ${kind === 'add_role' ? 'give' : 'remove'} this role: ${refusal.reason}`,
    });
    return;
  }

  const executor =
    input.roleIds && isScopedActionExecutor(ctx.executor)
      ? ctx.executor.scoped({ targetRoleIds: [...input.roleIds] })
      : ctx.executor;

  const result = await executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind,
    targetId: row.userId,
    actorId: ACHIEVEMENTS_ACTOR,
    reason: `Earned ${await lookups.label(row)}.`,
    payload: { userId: row.userId, roleId },
    dryRun: false,
    record: true,
    idempotencyKey:
      `achievements:${ctx.guildId}:${row.userId}:${row.achievementId}:${row.tierId}:` +
      `${row.generation}:${row.rewardKey}:${token}`,
  });

  if (result.status === 'executed' || result.status === 'dry_run') {
    await finish({ status: 'delivered' });
    return;
  }

  if (result.status === 'skipped_duplicate') {
    await finish(await confirmRole(ctx, deps, row, kind, roleId, token));
    return;
  }

  const failure = result.failure ?? {
    code: 'unknown',
    humanReason: 'Discord refused the role change without saying why.',
  };
  const outcome = failureOutcome(failure, kind, token, clockOf(deps)());
  await finish(outcome);

  ctx.logger.warn(
    `achievements could not ${kind === 'add_role' ? 'give' : 'remove'} reward role ${roleId} ` +
      `for ${row.userId} (${row.achievementId}, ${row.tierId}): ${failure.humanReason}` +
      (outcome.transient ? ' It will be tried again.' : ''),
    { guildId: ctx.guildId, moduleId: MODULE_ID, userId: row.userId, code: failure.code },
  );
}

async function deliverXp(
  ctx: Context,
  row: RewardRow,
  lookups: Lookups,
  input: RewardDelivery,
  finish: Finish,
): Promise<void> {
  const amount = row.amount ?? 0;
  if (!Number.isInteger(amount) || amount < 1) {
    await finish({
      status: 'failed',
      errorCode: 'invalid_reward',
      error: 'This XP reward has no amount Proton can give.',
    });
    return;
  }

  if (!(await lookups.moduleOn('leveling'))) {
    await finish({ status: 'failed', errorCode: 'leveling_off', error: levelingOffReason(amount) });
    return;
  }

  const grantId = xpGrantId(
    ctx.guildId,
    row.userId,
    row.achievementId,
    row.tierId,
    row.rewardEpoch,
  );
  const unlock =
    input.causation === undefined || input.originChannelId === undefined
      ? await lookups.unlock(row)
      : null;

  const causation: Causation = input.causation ?? {
    kind: 'achievement',
    rootId: `achievements:${ctx.guildId}:${row.userId}:${row.achievementId}:${row.tierId}:${row.generation}`,
    depth: unlock?.cause.depth ?? 0,
  };
  const origin =
    input.originChannelId !== undefined ? input.originChannelId : (unlock?.originChannelId ?? null);

  const parsed = xpGrantRequestedSchema.safeParse({
    guildId: ctx.guildId,
    userId: row.userId,
    grantId,
    amount,
    reason: `Earned ${await lookups.label(row)}.`.slice(0, 200),
    sourceModule: MODULE_ID,
    ...(origin ? { originChannelId: origin } : {}),
    causation: {
      kind: 'achievement',
      rootId: causation.rootId,
      depth: Math.min(causation.depth, 32),
      grantId,
      sourceModule: MODULE_ID,
    },
  });

  if (!parsed.success) {
    await finish({
      status: 'failed',
      errorCode: 'invalid_reward',
      error: 'Proton couldn’t build the request for this XP reward.',
    });
    ctx.logger.error(
      `achievements could not ask Leveling for ${amount} XP (${grantId}): ${parsed.error.message}`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  if (!ctx.publish) {
    ctx.logger.error(
      `achievements could not ask Leveling for ${amount} XP (${grantId}): this module’s context ` +
        'has no publish port. The process running modules must supply ModuleContext.publish.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return;
  }

  try {
    await ctx.publish('xp.grant_requested', grantId, parsed.data);
  } catch (error) {
    ctx.logger.error(
      `achievements could not ask Leveling for ${amount} XP (${grantId}); the sweep asks again: ` +
        reasonOf(error),
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
  }
}

export async function deliverDue(
  ctx: Context,
  deps: AchievementsDeps,
  rows: readonly RewardRow[],
): Promise<void> {
  const groups = new Map<
    string,
    { userId: string; achievementId: string; generation: number; only: Set<string> }
  >();

  for (const row of rows) {
    const key = JSON.stringify([row.userId, row.achievementId, row.generation]);
    const group = groups.get(key) ?? {
      userId: row.userId,
      achievementId: row.achievementId,
      generation: row.generation,
      only: new Set<string>(),
    };
    group.only.add(rewardSlot(row));
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    try {
      await deliverRewards(ctx, deps, group);
    } catch (error) {
      ctx.logger.error(
        `achievements could not deliver the rewards ${group.userId} earned for ` +
          `${group.achievementId}; the sweep tries again: ${reasonOf(error)}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, userId: group.userId },
      );
    }
  }
}

function retryResult(
  ref: AchievementRewardRef,
  status: AchievementRetryStatus,
  message: string,
): AchievementRetryResult {
  return { ...ref, status, message: message.slice(0, 400) };
}

function beforeRetry(
  row: RewardRow,
  now: number,
): { status: AchievementRetryStatus; message: string } | null {
  switch (row.status) {
    case 'delivered':
      return { status: 'delivered', message: 'Already given.' };
    case 'skipped':
      return { status: 'skipped', message: row.error ?? 'Skipped.' };
    case 'cancelled':
      return { status: 'not_retryable', message: row.error ?? CANCELLED_BY_RESET };
    case 'requested':
      return leaseOver(row, now)
        ? null
        : { status: 'requested', message: 'Proton is still waiting for Leveling to confirm it.' };
    case 'delivering':
      return leaseOver(row, now)
        ? null
        : { status: 'not_retryable', message: 'Proton is giving it right now.' };
    default:
      return null;
  }
}

function afterRetry(row: RewardRow): { status: AchievementRetryStatus; message: string } {
  switch (row.status) {
    case 'delivered':
      return { status: 'delivered', message: 'Given.' };
    case 'requested':
      return {
        status: 'requested',
        message: 'Asked Leveling for the XP. It shows as given once Leveling confirms.',
      };
    case 'failed':
      return { status: 'failed', message: row.error ?? 'It couldn’t be given.' };
    case 'skipped':
      return { status: 'skipped', message: row.error ?? 'Skipped.' };
    case 'cancelled':
      return { status: 'not_retryable', message: row.error ?? CANCELLED_BY_RESET };
    default:
      return {
        status: 'not_retryable',
        message: 'Proton couldn’t pick it up just now. Try again in a minute.',
      };
  }
}

export async function retryReward(
  ctx: Context,
  deps: AchievementsDeps,
  ref: AchievementRewardRef,
): Promise<AchievementRetryResult> {
  const store = deps.store;
  if (!store) {
    return retryResult(ref, 'not_retryable', 'Achievement records aren’t available right now.');
  }

  const rows = await store.rewardsFor(ctx.guildId, ref.userId, ref.achievementId, ref.generation);
  const row = rows.find(
    (candidate) => candidate.tierId === ref.tierId && candidate.rewardKey === ref.rewardKey,
  );
  if (!row) return retryResult(ref, 'not_found', 'That reward isn’t on record any more.');

  const early = beforeRetry(row, clockOf(deps)());
  if (early) return retryResult(ref, early.status, early.message);

  // unlocksOf holds only current, unvoided unlocks: a tier a reset voided is never given again.
  const held = await store.unlocksOf(ctx.guildId, ref.userId);
  const stands = held.some(
    (unlock) =>
      unlock.achievementId === ref.achievementId &&
      unlock.tierId === ref.tierId &&
      unlock.generation === ref.generation,
  );
  if (!stands) return retryResult(ref, 'not_retryable', CANCELLED_BY_RESET);

  const after = await deliverRewards(ctx, deps, {
    userId: ref.userId,
    achievementId: ref.achievementId,
    generation: ref.generation,
    only: new Set([rewardSlot(row)]),
    manual: true,
  });

  const final = after.find((candidate) => rewardSlot(candidate) === rewardSlot(row)) ?? row;
  const outcome = afterRetry(final);
  return retryResult(ref, outcome.status, outcome.message);
}
