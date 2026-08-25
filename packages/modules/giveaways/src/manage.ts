import type { ProviderRegistry } from '@proton/core';
import { refreshMessage } from './announce.ts';
import { MODULE_ID } from './config.ts';
import type { Ctx } from './perform.ts';
import { END_JOB_ID } from './schedule.ts';
import type { Giveaway, GiveawayPatch, GiveawayStore } from './store.ts';

export interface ManageDeps {
  store: GiveawayStore;
  providers: ProviderRegistry;
  now?: () => number;
}

export type ManageOutcome =
  | { outcome: 'ok'; giveaway: Giveaway }
  | { outcome: 'missing' }
  | { outcome: 'wrong-state'; giveaway: Giveaway };

async function wrongState(deps: ManageDeps, guildId: string, id: string): Promise<ManageOutcome> {
  const current = await deps.store.get(guildId, id);
  return current ? { outcome: 'wrong-state', giveaway: current } : { outcome: 'missing' };
}

/**
 * Moves the scheduled draw. `replace: true` is load-bearing — both existing callers schedule with
 * the default `keep`, so without it a giveaway that is extended still fires at the old deadline.
 */
async function rescheduleEnd(ctx: Ctx, giveaway: Giveaway): Promise<void> {
  await ctx.schedule?.(
    END_JOB_ID,
    giveaway.endsAt,
    `${MODULE_ID}:${giveaway.id}`,
    { giveawayId: giveaway.id },
    { replace: true },
  );
}

async function repaint(ctx: Ctx, deps: ManageDeps, giveaway: Giveaway, key: string): Promise<void> {
  await refreshMessage(ctx, { store: deps.store, providers: deps.providers }, giveaway, key);
}

export async function pauseGiveaway(
  ctx: Ctx,
  deps: ManageDeps,
  input: { giveawayId: string; by: string; reason?: string | null },
): Promise<ManageOutcome> {
  const at = new Date(deps.now?.() ?? Date.now());

  const paused = await deps.store.pause(
    ctx.guildId,
    input.giveawayId,
    input.by,
    input.reason ?? null,
    at,
  );

  if (!paused) return wrongState(deps, ctx.guildId, input.giveawayId);

  // The end job is left where it is: resume pushes ends_at forward and reschedules, and a job that
  // fires while paused finds a non-running row and draws nothing.
  await repaint(ctx, deps, paused, `giveaways:${paused.id}:pause:${at.getTime()}`);

  return { outcome: 'ok', giveaway: paused };
}

export async function resumeGiveaway(
  ctx: Ctx,
  deps: ManageDeps,
  input: { giveawayId: string },
): Promise<ManageOutcome> {
  const at = new Date(deps.now?.() ?? Date.now());

  const resumed = await deps.store.resume(ctx.guildId, input.giveawayId, at);
  if (!resumed) return wrongState(deps, ctx.guildId, input.giveawayId);

  await rescheduleEnd(ctx, resumed);
  await repaint(ctx, deps, resumed, `giveaways:${resumed.id}:resume:${at.getTime()}`);

  return { outcome: 'ok', giveaway: resumed };
}

export type ShiftOutcome = ManageOutcome | { outcome: 'too-short'; giveaway: Giveaway };

/**
 * Shared by extend and shorten. `by` is signed; shortening past the present is refused rather than
 * silently drawing, because "shorten by 3 days" on a giveaway with an hour left is a typo far more
 * often than it is an instruction.
 */
export async function shiftDeadline(
  ctx: Ctx,
  deps: ManageDeps,
  input: { giveawayId: string; byMs: number },
): Promise<ShiftOutcome> {
  const at = new Date(deps.now?.() ?? Date.now());

  const current = await deps.store.get(ctx.guildId, input.giveawayId);
  if (!current) return { outcome: 'missing' };

  const endsAt = new Date(current.endsAt.getTime() + input.byMs);
  if (endsAt.getTime() <= at.getTime()) return { outcome: 'too-short', giveaway: current };

  const patched = await deps.store.patch(
    ctx.guildId,
    input.giveawayId,
    ['scheduled', 'running', 'paused'],
    { endsAt },
  );

  if (!patched) return wrongState(deps, ctx.guildId, input.giveawayId);

  await rescheduleEnd(ctx, patched);
  await repaint(ctx, deps, patched, `giveaways:${patched.id}:shift:${endsAt.getTime()}`);

  return { outcome: 'ok', giveaway: patched };
}

export async function editGiveawayFields(
  ctx: Ctx,
  deps: ManageDeps,
  input: { giveawayId: string; patch: GiveawayPatch },
): Promise<ManageOutcome> {
  const patched = await deps.store.patch(
    ctx.guildId,
    input.giveawayId,
    ['scheduled', 'running', 'paused'],
    input.patch,
  );

  if (!patched) return wrongState(deps, ctx.guildId, input.giveawayId);

  if (input.patch.endsAt !== undefined) await rescheduleEnd(ctx, patched);

  // Keyed on updatedAt so two different edits are two different edits, and a redelivered one is not.
  await repaint(ctx, deps, patched, `giveaways:${patched.id}:edit:${patched.updatedAt.getTime()}`);

  return { outcome: 'ok', giveaway: patched };
}
