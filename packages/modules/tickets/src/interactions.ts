import {
  deferEphemeral,
  type EventListener,
  type EventType,
  followUp,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  parseCustomId,
  readComponentInteraction,
} from '@proton/core';
import { MODULE_ID, panelFor, type TicketsConfig } from './config.ts';
import { bindButton, describeUnbound, type TicketsDeps } from './deps.ts';
import { openTicket } from './lifecycle.ts';
import { OPEN_ACTION } from './panel.ts';

export const TICKET_INTERACTION_EVENT_TYPES: EventType[] = ['interaction.component'];

export type OpenPress = { panelId: string };

export function readOpenPress(customId: unknown): OpenPress | null {
  const parsed = parseCustomId(customId);
  const panelId = parsed?.args.length === 1 ? parsed.args[0] : undefined;

  if (!parsed || parsed.moduleId !== MODULE_ID || parsed.action !== OPEN_ACTION || !panelId) {
    return null;
  }

  return { panelId };
}

export type PressOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'opened'; channelId: string }
  | { action: 'refused'; reason: string };

export async function handleOpenPress(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
  deps: TicketsDeps,
): Promise<PressOutcome> {
  const facts = readComponentInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  const press = readOpenPress(facts.customId);
  if (!press) return { action: 'ignored', reason: 'the component is not a ticket panel button' };

  const bound = bindButton(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('the ticket panel button', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'refused', reason: 'the module is not fully wired' };
  }

  const to = {
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    actorId: facts.userId,
    interaction: interactionRef(facts),
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  };

  // Deferred before anything slow: opening a ticket writes a row and creates a channel, and the
  // acknowledgement deadline is three seconds (I9).
  await ctx.executor.execute(deferEphemeral(to));

  const say = async (content: string): Promise<void> => {
    const result = await ctx.executor.execute(
      followUp({ ...to, applicationId: bound.applicationId }, content),
    );

    if (result.status === 'failed_precheck' || result.status === 'failed_api') {
      ctx.logger.error(
        `a member pressed a ticket button and could not be told what happened: ${
          result.failure?.humanReason ?? 'unknown reason'
        }`,
        { guildId: ctx.guildId, moduleId: MODULE_ID, code: result.failure?.code },
      );
    }
  };

  const panel = panelFor(ctx.config, press.panelId);
  if (!panel) {
    await say(
      'That button belongs to a ticket panel that no longer exists in this server’s settings, ' +
        'so nothing was opened. An admin can repost the panel from the Proton dashboard.',
    );
    return { action: 'refused', reason: 'the panel is gone' };
  }

  const opened = await openTicket({
    ctx,
    store: bound.store,
    deps,
    panel,
    openerId: facts.userId,
    openerName: facts.userId,
    idempotencyKey: `${MODULE_ID}:${event.id}`,
  });

  if (opened.status === 'duplicate') {
    return { action: 'ignored', reason: 'an earlier delivery of this press already opened it' };
  }

  if (opened.status === 'refused') {
    await say(opened.humanReason);
    return { action: 'refused', reason: opened.humanReason };
  }

  await say(
    `Opened ticket #${opened.ticket.number} — <#${opened.ticket.channelId}>. ` +
      'Everything you say there is visible only to you and the support team.',
  );

  return { action: 'opened', channelId: opened.ticket.channelId };
}

export function createTicketInteractionListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_INTERACTION_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      await handleOpenPress(event, ctx, deps);
    },
  };
}
