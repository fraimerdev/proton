import type { EventListener, EventType } from '@proton/core';
import type { RolemenuConfig } from './config.ts';
import type { RolemenuDeps } from './deps.ts';
import { handleComponent } from './interactions.ts';
import { handleReaction } from './reactions.ts';

/** Reaction menus. Needs GuildMessageReactions, which is not privileged. */
export const REACTION_EVENT_TYPES: EventType[] = ['reaction.added', 'reaction.removed'];

/** Button and dropdown menus. INTERACTION_CREATE type 3 needs no intent at all. */
export const COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

export const ROLEMENU_EVENT_TYPES: EventType[] = [
  ...REACTION_EVENT_TYPES,
  ...COMPONENT_EVENT_TYPES,
];

/**
 * Two listeners rather than one handler with a switch.
 *
 * The two paths are not variations on each other. A reaction has no invoker to
 * answer and no clock to beat, so it can take as long as it takes and reports
 * failures to the log; a component press has somebody waiting, three seconds to
 * acknowledge them in, and a fifteen-minute token afterwards. They also fail
 * differently — a reaction menu is unusable without `botUserId`, a component menu
 * without `applicationId` — and one handler would have to carry both conditions
 * to do either job.
 */
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
