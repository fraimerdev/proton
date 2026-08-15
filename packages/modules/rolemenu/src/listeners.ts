import type { EventListener, EventType } from '@proton/core';
import type { RolemenuConfig } from './config.ts';
import type { RolemenuDeps } from './deps.ts';
import { handleComponent } from './interactions.ts';
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
