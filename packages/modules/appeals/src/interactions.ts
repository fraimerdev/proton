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
  type StatusBody,
  successStatus,
} from '@proton/core';
import { mayReview, readPermissions, readRoleIds } from './authorize.ts';
import { type AppealPanel, type AppealsConfig, MODULE_ID, panelFor } from './config.ts';
import { type ApplyOutcome, applyDecision, stampCard } from './decision.ts';
import { type AppealsDeps, bindAppealsDeps, describeUnbound } from './deps.ts';
import { type NotifyOutcome, tellAppellant } from './notify.ts';
import { APPROVE_ACTION, DENY_ACTION } from './review.ts';
import type { AppealRecord, AppealStore } from './store.ts';

export const APPEALS_INTERACTION_EVENT_TYPES: EventType[] = ['interaction.component'];

const VERDICT = { approved: 'accepted', denied: 'turned down' } as const;

interface Finished {
  applied: ApplyOutcome;
  told: NotifyOutcome;
}

function toldSentence(member: string, told: NotifyOutcome): string {
  switch (told) {
    case 'sent':
      return `${member} has been told.`;
    case 'closed':
      return (
        `I couldn’t DM ${member}. Their DMs are closed, or they no longer share a server ` +
        'with me.'
      );
    case 'unconfirmed':
      return `I can’t tell whether ${member} got the decision, because Discord didn’t confirm it.`;
    case 'failed':
    case 'gave_up':
      return `I couldn’t send ${member} the decision, so let them know yourself.`;
  }
}

function notLifted(member: string, panel: AppealPanel, humanReason: string): string {
  return panel.onApprove === 'unban'
    ? `I couldn’t unban ${member}: ${humanReason} Lift the ban by hand if it’s still in place.`
    : `I couldn’t lift the timeout on ${member}: ${humanReason} Lift it by hand if it’s still ` +
        'in place.';
}

function decidedReply(
  appeal: AppealRecord,
  decision: 'approved' | 'denied',
  panel: AppealPanel,
  done: Finished,
  repeated: boolean,
): StatusBody {
  const member = `<@${appeal.userId}>`;
  const verdict = VERDICT[decision];
  const told = toldSentence(member, done.told);

  if (done.applied.humanReason !== null) {
    return errorStatus(
      `Appeal #${appeal.number} ${repeated ? 'was already ' : ''}${verdict}, but ` +
        `${notLifted(member, panel, done.applied.humanReason)} ${told}`,
    );
  }

  if (!repeated) return successStatus(`Appeal #${appeal.number} ${verdict}. ${told}`);

  return successStatus(
    `Appeal #${appeal.number} was already ${verdict}. I’ve finished carrying it out` +
      (done.told === 'sent' ? `, and ${told}` : `. ${told}`),
  );
}

function alreadyDecided(fresh: AppealRecord | null): string {
  if (!fresh || fresh.status === 'open' || !fresh.decidedBy) {
    return 'That appeal is no longer waiting on a decision, so nothing changed.';
  }

  return (
    `Someone else got there first. Appeal #${fresh.number} was ${VERDICT[fresh.status]} by ` +
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
        errorStatus('I can’t record appeal decisions right now, so nothing changed.'),
      ),
    );
    return { action: 'refused', reason: 'the appeal store is unbound' };
  }

  const { store } = bound.deps;

  const held = await store.find(ctx.guildId, appealId);
  if (!held) {
    await ctx.executor.execute(
      replyEphemeral(to, errorStatus('I couldn’t find that appeal, so nothing changed.')),
    );
    return { action: 'ignored', reason: 'no such appeal' };
  }

  const panel = panelFor(ctx.config, held.panelId);
  if (!panel) {
    await ctx.executor.execute(
      replyEphemeral(
        to,
        errorStatus(
          'The appeal form this belonged to has been deleted, so I don’t know what accepting it ' +
            'should do. Recreate the form with the same ID, or handle this appeal by hand.',
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
      const done = await finish(ctx, rawDeps, store, fresh, panel);

      await ctx.executor.execute(
        replyEphemeral(to, decidedReply(fresh, decision, panel, done, true)),
      );
      return { action: 'decided', decision, appealId };
    }

    await ctx.executor.execute(replyEphemeral(to, errorStatus(alreadyDecided(fresh))));
    return { action: 'ignored', reason: 'already decided' };
  }

  const done = await finish(ctx, rawDeps, store, decided, panel);

  await ctx.executor.execute(
    replyEphemeral(to, decidedReply(decided, decision, panel, done, false)),
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
  store: AppealStore,
  appeal: AppealRecord,
  panel: AppealPanel,
): Promise<Finished> {
  const applied = await applyDecision(ctx, rawDeps, appeal, panel);
  if (applied.lifted) await store.markApplied(ctx.guildId, appeal.id);

  const told = await tellAppellant(ctx, store, appeal, panel);
  // Last on purpose: a crash before this leaves the card's buttons live for a second press.
  await stampCard(ctx, store, appeal, panel);

  return { applied, told };
}

export function createAppealsInteractionListener(deps: AppealsDeps): EventListener<AppealsConfig> {
  return {
    types: APPEALS_INTERACTION_EVENT_TYPES,
    async handler(event, ctx) {
      await handleReviewPress(event, ctx, deps);
    },
  };
}
