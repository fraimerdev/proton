import type { EventListener, EventType } from '@proton/core';
import type { SuggestionsConfig } from './config.ts';
import type { SuggestionsDeps } from './deps.ts';
import { handleVote } from './interactions.ts';

export const SUGGESTIONS_EVENT_TYPES: EventType[] = ['interaction.component'];

export function createVoteListener(deps: SuggestionsDeps): EventListener<SuggestionsConfig> {
  return {
    types: SUGGESTIONS_EVENT_TYPES,
    async handler(event, ctx) {
      await handleVote(event, ctx, deps);
    },
  };
}
