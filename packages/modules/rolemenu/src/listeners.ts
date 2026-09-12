import { type EventListener, type EventType, protonPanelRequestedSchema } from '@proton/core';
import { findMenu, type RolemenuConfig } from './config.ts';
import type { RolemenuDeps } from './deps.ts';
import { handleComponent } from './interactions.ts';
import { MODULE_ID } from './perform.ts';
import { postMenu } from './post.ts';
import { handleReaction } from './reactions.ts';

export const REACTION_EVENT_TYPES: EventType[] = ['reaction.added', 'reaction.removed'];

export const COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

export const ROLEMENU_EVENT_TYPES: EventType[] = [
  ...REACTION_EVENT_TYPES,
  ...COMPONENT_EVENT_TYPES,
];

export function createReactionListener(deps: RolemenuDeps): EventListener<RolemenuConfig> {
  return {
    types: REACTION_EVENT_TYPES,
    async handler(event, ctx) {
      await handleReaction(event, ctx, deps);
    },
  };
}

export function createComponentListener(deps: RolemenuDeps): EventListener<RolemenuConfig> {
  return {
    types: COMPONENT_EVENT_TYPES,
    async handler(event, ctx) {
      await handleComponent(event, ctx, deps);
    },
  };
}

export const PANEL_EVENT_TYPES: EventType[] = ['proton.panel_requested'];

/**
 * The dashboard's "post it" button. The api cannot talk to Discord, so it publishes and this does
 * the work — the same postMenu the slash command runs, on the config as it is now rather than as
 * the page had it.
 */
export function createPanelListener(_deps: RolemenuDeps): EventListener<RolemenuConfig> {
  return {
    types: PANEL_EVENT_TYPES,
    async handler(event, ctx) {
      const asked = protonPanelRequestedSchema.safeParse(event.payload);

      // Every module hears every request; only the one named acts on it.
      if (!asked.success || asked.data.moduleId !== MODULE_ID) return;

      const menu = findMenu(ctx.config, asked.data.panelId);
      if (!menu) {
        ctx.logger.warn(`rolemenu was asked to post '${asked.data.panelId}', which is not a menu`, {
          guildId: ctx.guildId,
          moduleId: MODULE_ID,
        });
        return;
      }

      const posted = await postMenu(ctx, menu, {
        actorId: asked.data.actorId,
        idempotencyKey: asked.data.auditId,
      });

      if (posted.ok) return;

      ctx.logger.error(
        `rolemenu could not ${posted.refreshed ? 'refresh' : 'post'} '${menu.id}': ` +
          `${posted.humanReason}`,
        { guildId: ctx.guildId, moduleId: MODULE_ID },
      );
    },
  };
}
