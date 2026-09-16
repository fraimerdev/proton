import {
  type EventListener,
  type EventType,
  errorStatus,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
  replyEphemeral,
  successStatus,
} from '@proton/core';
import { mayReview, readPermissions, readRoleIds } from './authorize.ts';
import { type AppealsConfig, MODULE_ID, panelFor } from './config.ts';
import { applyDecision, stampCard } from './decision.ts';
import { type AppealsDeps, bindAppealsDeps, describeUnbound } from './deps.ts';
import { tellAppellant } from './notify.ts';
import { APPROVE_ACTION, DENY_ACTION } from './review.ts';
import type { AppealRecord } from './store.ts';

export const APPEALS_INTERACTION_EVENT_TYPES: EventType[] = ['interaction.component'];

const VERDICT = { approved: 'accepted', denied: 'turned down' } as const;

function alreadyDecided(fresh: AppealRecord | null): string {
  if (!fresh || fresh.status === 'open' || !fresh.decidedBy) {
    return 'That appeal is no longer waiting on a decision, so nothing has changed.';
  }

  return (
    `Somebody else got there first — appeal #${fresh.number} was ${VERDICT[fresh.status]} by ` +
    `<@${fresh.decidedBy}>.`
  );
}

export type ReviewOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'decided'; decision: 'approved' | 'denied'; appealId: string };

export async function handleReviewPress(
  event: ProtonEvent,
  ctx: ModuleContext<AppealsConfig>,
  rawDeps: AppealsDeps,
): Promise<ReviewOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const parsed = parseCustomId(facts.customId);
  if (!parsed || parsed.moduleId !== MODULE_ID) {
    return { action: 'ignored', reason: 'another module owns that component' };
  }

  if (parsed.action !== APPROVE_ACTION && parsed.action !== DENY_ACTION) {
    return { action: 'ignored', reason: `no appeals component called '${parsed.action}'` };
  }

  const appealId = parsed.args[0];
  if (!appealId) return { action: 'ignored', reason: 'the button carried no appeal' };

  const to = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };

  const bound = bindAppealsDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('an appeal decision went unrecorded', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });

    await ctx.executor.execute(
      replyEphemeral(
        to,
        errorStatus('I cannot record appeal decisions right now, so nothing has changed.'),
      ),
    );
    return { action: 'refused', reason: 'the appeal store is unbound' };
  }

  const { store } = bound.deps;

  const held = await store.find(ctx.guildId, appealId);
  if (!held) {
    await ctx.executor.execute(
      replyEphemeral(to, errorStatus('That appeal is no longer here, so nothing has changed.')),
    );
    return { action: 'ignored', reason: 'no such appeal' };
  }

  const panel = panelFor(ctx.config, held.panelId);
  if (!panel) {
    await ctx.executor.execute(
      replyEphemeral(
        to,
        errorStatus(
          'The appeal form this belonged to has been removed, so Proton does not know what ' +
            'accepting it should do. Re-create the form, or handle this one by hand.',
        ),
      ),
    );
    return { action: 'refused', reason: 'the panel is gone' };
  }

  const allowed = mayReview(ctx.config, panel, readPermissions(event), readRoleIds(event));
  if (!allowed.ok) {
    await ctx.executor.execute(replyEphemeral(to, errorStatus(allowed.humanReason)));
    return { action: 'refused', reason: allowed.humanReason };
  }

  const decision = parsed.action === APPROVE_ACTION ? 'approved' : 'denied';

  // The conditional UPDATE is the lock. Two reviewers pressing at once are two event ids, so the
  // executor's dedupe cannot arbitrate between them — the loser is told who got there first.
  const decided = await store.decide({
    guildId: ctx.guildId,
    appealId,
    decision,
    decidedBy: facts.userId,
  });

  if (!decided) {
    const fresh = await store.find(ctx.guildId, appealId);

    // Same button, already-recorded decision: re-run every effect. They are all keyed off the
    // appeal id, so this repairs a crash between the decision and the unban rather than doubling it.
    if (fresh && fresh.status === decision) {
      await finish(ctx, rawDeps, fresh, panel);

      await ctx.executor.execute(
        replyEphemeral(
          to,
          successStatus(
            `Appeal #${fresh.number} was already ${VERDICT[decision]}. I have finished carrying ` +
              `it out, and <@${fresh.userId}> has been told.`,
          ),
        ),
      );
      return { action: 'decided', decision, appealId };
    }

    await ctx.executor.execute(replyEphemeral(to, errorStatus(alreadyDecided(fresh))));
    return { action: 'ignored', reason: 'already decided' };
  }

  await finish(ctx, rawDeps, decided, panel);

  await ctx.executor.execute(
    replyEphemeral(
      to,
      successStatus(
        `Appeal #${decided.number} ${VERDICT[decision]}. <@${decided.userId}> has been told.`,
      ),
    ),
  );

  await ctx.publish?.('appeals.decided', decided.id, {
    guildId: ctx.guildId,
    userId: decided.userId,
    appealId: decided.id,
    panelId: decided.panelId,
    decision,
    decidedBy: facts.userId,
    decidedAt: bound.deps.now(),
  });

  return { action: 'decided', decision, appealId };
}

async function finish(
  ctx: ModuleContext<AppealsConfig>,
  rawDeps: AppealsDeps,
  appeal: Parameters<typeof stampCard>[2],
  panel: Parameters<typeof stampCard>[3],
): Promise<void> {
  const store = rawDeps.store;
  if (!store) return;

  const applied = await applyDecision(ctx, rawDeps, appeal, panel);
  if (applied.lifted) await store.markApplied(ctx.guildId, appeal.id);

  await tellAppellant(ctx, store, appeal, panel);
  await stampCard(ctx, store, appeal, panel);
}

export function createAppealsInteractionListener(deps: AppealsDeps): EventListener<AppealsConfig> {
  return {
    types: APPEALS_INTERACTION_EVENT_TYPES,
    async handler(event, ctx) {
      await handleReviewPress(event, ctx, deps);
    },
  };
}
