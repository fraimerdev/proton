import type { EventListener, EventType, ModuleContext, ProtonEvent } from '@proton/core';
import { appealSubmittedSchema } from '@proton/core';
import {
  APPEALS_ACTOR,
  type AppealsConfig,
  MODULE_ID,
  panelFor,
  reviewChannelFor,
} from './config.ts';
import { type AppealsDeps, bindAppealsDeps, describeUnbound } from './deps.ts';
import { buildReviewCard } from './review.ts';

export const APPEALS_EVENT_TYPES: EventType[] = ['appeals.submitted'];

export type PostOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'refused'; reason: string }
  | { action: 'posted'; channelId: string };

export async function postReviewCard(
  event: ProtonEvent,
  ctx: ModuleContext<AppealsConfig>,
  rawDeps: AppealsDeps,
): Promise<PostOutcome> {
  const payload = appealSubmittedSchema.safeParse(event.payload);
  if (!payload.success) return { action: 'ignored', reason: 'unreadable appeal payload' };

  const bound = bindAppealsDeps(rawDeps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('an appeal was not posted for review', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: 'the appeal store is unbound' };
  }

  const appeal = await bound.deps.store.find(ctx.guildId, payload.data.appealId);
  if (!appeal) return { action: 'ignored', reason: 'no such appeal' };

  const panel = panelFor(ctx.config, appeal.panelId);
  if (!panel) {
    ctx.logger.error(
      `appeal #${appeal.number} was filed against a form that no longer exists, so nobody was ` +
        'shown it. Re-create the form to see the appeals filed under it.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'refused', reason: 'the panel is gone' };
  }

  const channelId = reviewChannelFor(ctx.config, panel);
  if (!channelId) {
    ctx.logger.error(
      `appeal #${appeal.number} has nowhere to go: neither the '${panel.name}' form nor this ` +
        'server names a review channel. Set one under Appeals in the Proton dashboard.',
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'refused', reason: 'no review channel is configured' };
  }

  const built = buildReviewCard(appeal, panel);
  if (!built.ok) return { action: 'refused', reason: built.humanReason };

  const posted = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: APPEALS_ACTOR,
    dryRun: false,
    record: false,

    // Keyed on the appeal, not the event: the api republishes when the same link is opened again,
    // and a second card would give two reviewers two sets of buttons over one appeal.
    idempotencyKey: `${MODULE_ID}:${appeal.id}:card`,
    payload: {
      channelId,
      components: built.components,
      flags: 1 << 15,
      allowedMentions: { parse: [] },
    },
  });

  if (posted.status !== 'executed') {
    ctx.logger.error(
      `appeal #${appeal.number} could not be posted to ${channelId}: ${
        posted.failure?.humanReason ?? 'Discord gave no reason.'
      }`,
      { guildId: ctx.guildId, moduleId: MODULE_ID },
    );
    return { action: 'refused', reason: 'the review card was refused' };
  }

  const messageId = (posted.body as { id?: unknown } | undefined)?.id;
  if (typeof messageId === 'string') {
    await bound.deps.store.rememberCard(ctx.guildId, appeal.id, channelId, messageId);
  }

  return { action: 'posted', channelId };
}

export function createAppealsListener(deps: AppealsDeps): EventListener<AppealsConfig> {
  return {
    types: APPEALS_EVENT_TYPES,
    async handler(event, ctx) {
      await postReviewCard(event, ctx, deps);
    },
  };
}
