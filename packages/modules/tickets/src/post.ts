import {
  type ActionExecutor,
  checkListLimit,
  type EntitlementTier,
  type EventListener,
  type EventType,
  protonPanelRequestedSchema,
} from '@proton/core';

import { MODULE_ID, panelFor, type TicketPanel, type TicketsConfig, typesOf } from './config.ts';

import { buildPanelMessage } from './panel.ts';

export interface SendPanelResult {
  ok: boolean;
  humanReason?: string;
}

/**
 * Posting one panel, with no interaction and no reply. `/ticket panel` and the dashboard's own
 * button both land here, so a panel posted from the page is the message the command would have
 * made — before this the posting lived inside the command handler and the dashboard could only
 * tell an admin to go and run it.
 */
export async function sendPanel(
  ctx: { guildId: string; executor: ActionExecutor; config: TicketsConfig; tier?: EntitlementTier },
  panel: TicketPanel,
  options: { actorId: string; idempotencyKey: string },
): Promise<SendPanelResult> {
  // Checked here as well as at save time: an admin who added panels while on plus and then let the
  // tier lapse must not be able to keep posting the ones over the limit.
  const allowed = checkListLimit(ctx.tier ?? 'free', 'ticketPanels', ctx.config.panels.length);
  if (!allowed.ok) return { ok: false, humanReason: allowed.humanReason };

  const message = buildPanelMessage(panel, typesOf(ctx.config, panel));
  if (!message.ok) return { ok: false, humanReason: message.humanReason };

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: MODULE_ID,
    kind: 'send',
    actorId: options.actorId,
    idempotencyKey: `${options.idempotencyKey}:panel`,
    dryRun: false,
    record: false,
    payload: {
      channelId: panel.channelId,
      components: message.components,
      flags: 32768,
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    return { ok: false, humanReason: result.failure?.humanReason ?? 'unknown reason' };
  }

  return { ok: true };
}

export const PANEL_EVENT_TYPES: EventType[] = ['proton.panel_requested'];

/**
 * The dashboard's "post it" button. The api cannot talk to Discord, so it publishes and this does
 * the work — the same sendPanel the slash command runs, on the config as it is now rather than as
 * the page had it.
 */
export function createTicketPanelListener(): EventListener<TicketsConfig> {
  return {
    types: PANEL_EVENT_TYPES,
    async handler(event, ctx) {
      const asked = protonPanelRequestedSchema.safeParse(event.payload);

      // Every module hears every request; only the one named acts on it.
      if (!asked.success || asked.data.moduleId !== MODULE_ID) return;

      const panel = panelFor(ctx.config, asked.data.panelId);
      if (!panel) {
        ctx.logger.warn(`tickets was asked to post '${asked.data.panelId}', which is not a panel`, {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      const posted = await sendPanel(ctx, panel, {
        actorId: asked.data.actorId,
        idempotencyKey: asked.data.auditId,
      });

      if (posted.ok) return;

      ctx.logger.error(`tickets could not post '${panel.id}': ${posted.humanReason}`, {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
      });
    },
  };
}
