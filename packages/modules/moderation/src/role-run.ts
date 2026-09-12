import {
  type ActionExecutor,
  isScopedActionExecutor,
  type ModuleContext,
  type ScheduledHandler,
} from '@proton/core';
import type { ModerationConfig } from './config.ts';
import type { ModerationDeps } from './deps.ts';
import type { GuildMemberSummary } from './members.ts';
import { MODULE_ID } from './perform.ts';
import { guardRole, guardTarget } from './role-guard.ts';
import { ROLE_RUN_MODE_LABELS, type RoleRun, type RoleRunStore } from './run-store.ts';

export const ROLE_RUN_JOB = 'moderation.role-run';

// One row per guild, so a second mass run cannot be booked while one is in flight and a tick
// always replaces its own predecessor rather than stacking.
export const ROLE_RUN_KEY = 'moderation:role-run';

// One page listed and at most one page granted per tick: the whole page is applied before the
// cursor moves, so a tick that dies mid-page redoes it rather than skipping the rest of it.
export const ROLE_RUN_PAGE = 100;

export const ROLE_RUN_TICK_MS = 1_500;

export const ROLE_RUN_LIST_ATTEMPTS = 5;

const BAR_WIDTH = 14;

export function matchesRun(run: RoleRun, member: GuildMemberSummary): boolean {
  switch (run.mode) {
    case 'all':
      return true;
    case 'bots':
      return member.bot;
    case 'humans':
      return !member.bot;
    case 'in':
      return run.targetRoleId !== undefined && member.roleIds.includes(run.targetRoleId);
  }
}

function bar(run: RoleRun): string {
  const total = run.approximateTotal ?? 0;
  if (total <= 0) return '';

  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((run.scanned / total) * BAR_WIDTH)));
  return `\n\`${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}\` `;
}

function tallies(run: RoleRun): string {
  const parts = [`${run.applied} given`];
  if (run.skipped > 0) parts.push(`${run.skipped} already had it`);
  if (run.failed > 0) parts.push(`${run.failed} refused`);
  return parts.join(' · ');
}

export function renderProgress(run: RoleRun): string {
  const scope = ROLE_RUN_MODE_LABELS[run.mode];
  const scoped =
    run.mode === 'in' && run.targetRoleId ? `everyone holding <@&${run.targetRoleId}>` : scope;

  const seen = run.approximateTotal
    ? `${run.scanned} of about ${run.approximateTotal} members`
    : `${run.scanned} members`;

  return (
    `Giving <@&${run.roleId}> to ${scoped}, asked for by <@${run.actorId}>.${bar(run)}\n` +
    `Looked at ${seen} — ${tallies(run)}.\n` +
    '-# Still running. `/role cancel` stops it where it is.'
  );
}

export function renderFinished(run: RoleRun, outcome: FinishOutcome): string {
  const head =
    outcome.kind === 'cancelled'
      ? `Stopped giving out <@&${run.roleId}>.`
      : outcome.kind === 'failed'
        ? `Gave up on <@&${run.roleId}>.`
        : `Finished giving out <@&${run.roleId}>.`;

  const body = `Looked at ${run.scanned} members — ${tallies(run)}.`;

  return outcome.kind === 'failed'
    ? `${head}\n${body}\n\n${outcome.humanReason}`
    : `${head}\n${body}`;
}

export type FinishOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; humanReason: string };

// `stage` and not run.scanned alone: a run that ends without scanning anybody new — cancelled,
// abandoned, or a last page that came back empty — would otherwise key its closing edit the same
// as the tick before it, and the executor's dedupe would drop the only message saying it is over.
async function editProgress(
  ctx: ModuleContext<ModerationConfig>,
  run: RoleRun,
  content: string,
  stage: string,
): Promise<void> {
  if (!run.messageId) return;

  const result = await ctx.executor.execute({
    guildId: run.guildId,
    moduleId: MODULE_ID,
    kind: 'edit_message',
    actorId: run.actorId,
    dryRun: false,
    record: false,
    idempotencyKey: `${run.runId}:${stage}`,
    payload: {
      channelId: run.channelId,
      messageId: run.messageId,
      content: content.slice(0, 2000),
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.warn(
      `the /role progress message could not be updated: ${
        result.failure?.humanReason ?? 'unknown reason'
      }. The run itself is unaffected and is still going.`,
      { guildId: run.guildId, moduleId: MODULE_ID, runId: run.runId },
    );
  }
}

async function finish(
  ctx: ModuleContext<ModerationConfig>,
  store: RoleRunStore,
  run: RoleRun,
  outcome: FinishOutcome,
): Promise<void> {
  // Cleared first: a failed edit must not leave the guild unable to start another run, and the
  // summary is reconstructible from the message that is already in the channel.
  await store.clear(run.guildId);
  await editProgress(ctx, run, renderFinished(run, outcome), 'final');

  ctx.logger.info(
    `/role ${run.mode} ${outcome.kind}: ${run.applied} given, ${run.skipped} already held it, ` +
      `${run.failed} refused, across ${run.scanned} members`,
    { guildId: run.guildId, moduleId: MODULE_ID, runId: run.runId, roleId: run.roleId },
  );
}

function rankedBy(executor: ActionExecutor, roleIds: string[]): ActionExecutor {
  return isScopedActionExecutor(executor) ? executor.scoped({ targetRoleIds: roleIds }) : executor;
}

// A run four hours and ninety thousand members deep must not be thrown away by one bad page: the
// cursor is the only thing that makes it resumable, and starting over re-walks every member it
// already granted, paying for each of them again.
async function retryOrAbandon(
  ctx: ModuleContext<ModerationConfig>,
  store: RoleRunStore,
  run: RoleRun,
  humanReason: string,
  retryable: boolean,
): Promise<void> {
  const attempts = run.listFailures + 1;

  if (!retryable || attempts >= ROLE_RUN_LIST_ATTEMPTS || !ctx.schedule) {
    await finish(ctx, store, run, { kind: 'failed', humanReason });
    return;
  }

  await store.put({ ...run, listFailures: attempts });

  ctx.logger.warn(
    `a /role run could not read what it needed (attempt ${attempts} of ` +
      `${ROLE_RUN_LIST_ATTEMPTS}): ${humanReason}`,
    { guildId: run.guildId, moduleId: MODULE_ID, runId: run.runId },
  );

  await ctx.schedule(
    ROLE_RUN_JOB,
    new Date(Date.now() + ROLE_RUN_TICK_MS * 2 ** attempts),
    ROLE_RUN_KEY,
    undefined,
    { replace: true },
  );
}

export function createRoleRunHandler(deps: ModerationDeps): ScheduledHandler<ModerationConfig> {
  return async (_data, ctx) => {
    const store = deps.roleRuns;
    const lister = deps.members;

    if (!store || !lister) {
      ctx.logger.error(
        'a mass /role run was scheduled but this deployment has no member lister or run store ' +
          'wired into the moderation module, so it cannot continue and has been dropped.',
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
      return;
    }

    const run = await store.get(ctx.guildId);
    if (!run) return;

    if (run.cancelled) {
      await finish(ctx, store, run, { kind: 'cancelled' });
      return;
    }

    const state = await deps.guildState?.get(ctx.guildId);
    if (!state) {
      await retryOrAbandon(
        ctx,
        store,
        run,
        "I couldn't read this server's roles, so I couldn't confirm the run is still allowed.",
        true,
      );
      return;
    }

    // Re-checked every tick, not just at invoke time: a run walks a large server for minutes or
    // hours, and a role moved above Proton or above the moderator who asked for it part way
    // through must stop being handed out, not carry on to the end of the member list.
    const stale = guardRole({
      state,
      roleId: run.roleId,
      actorId: run.actorId,
      actorRoleIds: run.actorRoleIds,
    });

    if (stale) {
      await finish(ctx, store, run, { kind: 'failed', humanReason: stale.refusal });
      return;
    }

    const page = await lister.list(ctx.guildId, run.after, ROLE_RUN_PAGE);
    if ('failure' in page) {
      await retryOrAbandon(ctx, store, run, page.failure, page.retryable);
      return;
    }

    const next = { ...run, listFailures: 0, scanned: run.scanned + page.members.length };

    for (const member of page.members) {
      if (!matchesRun(run, member)) continue;

      if (member.roleIds.includes(run.roleId)) {
        next.skipped += 1;
        continue;
      }

      // Staff are swept in by /role all like everybody else, so the invoker has to outrank each
      // of them the same way they would to change that member's roles by hand.
      if (
        guardTarget({
          state,
          actorId: run.actorId,
          actorRoleIds: run.actorRoleIds,
          targetId: member.userId,
          targetRoleIds: member.roleIds,
        })
      ) {
        next.failed += 1;
        continue;
      }

      // Scoped with the roles the page already carried: without the hint the precheck fetches
      // every member again to rank them, which is a second REST call per member and doubles what
      // a run of a few thousand costs.
      const result = await rankedBy(ctx.executor, member.roleIds).execute({
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        kind: 'add_role',
        actorId: run.actorId,
        targetId: member.userId,
        ...(run.reason ? { reason: run.reason } : {}),
        payload: { userId: member.userId, roleId: run.roleId },
        dryRun: false,
        // One case per member would write thousands of ledger rows for a single command. The run
        // is auditable through Discord's own audit log, which carries `reason` on every grant.
        record: false,
        idempotencyKey: `${run.runId}:${member.userId}`,
      });

      // A duplicate here is this run's own earlier attempt at the same member — the key is unique
      // per run — so it is a grant that landed, not a member who already had the role. Counting it
      // as skipped would under-report every page that got redone after a tick died part way.
      if (result.status === 'executed' || result.status === 'skipped_duplicate') next.applied += 1;
      else next.failed += 1;
    }

    // Re-read, because a tick works for as long as a page of grants takes and /role cancel lands
    // in the middle of that. Writing `next` straight back would put the flag the moderator just
    // set back to false, and the run would carry on to the end of the server.
    const latest = await store.get(ctx.guildId);
    if (!latest) return;
    if (latest.cancelled) next.cancelled = true;

    if (next.cancelled) {
      await finish(ctx, store, next, { kind: 'cancelled' });
      return;
    }

    if (page.next === null) {
      await finish(ctx, store, next, { kind: 'done' });
      return;
    }

    next.after = page.next;
    await store.put(next);
    await editProgress(ctx, next, renderProgress(next), `progress:${next.scanned}`);

    if (!ctx.schedule) {
      await finish(ctx, store, next, {
        kind: 'failed',
        humanReason:
          'This deployment has no durable scheduler wired into the module runtime, so the run ' +
          'cannot book its next chunk.',
      });
      return;
    }

    await ctx.schedule(
      ROLE_RUN_JOB,
      new Date(Date.now() + ROLE_RUN_TICK_MS),
      ROLE_RUN_KEY,
      undefined,
      {
        replace: true,
      },
    );
  };
}
