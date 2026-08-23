import type { EventListener, EventType } from '@proton/core';
import { handleAutocomplete } from './autocomplete.ts';
import { handleBuilderPress, handleBuilderSubmit } from './builder/interactions.ts';
import type { GiveawaysConfig } from './config.ts';
import type { GiveawaysDeps } from './deps.ts';
import { bindBuilder } from './deps.ts';
import { handleEnter } from './interactions.ts';

export const COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

export const AUTOCOMPLETE_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

export const MODAL_EVENT_TYPES: EventType[] = ['interaction.modal'];

export const GIVEAWAYS_EVENT_TYPES: EventType[] = [
  ...COMPONENT_EVENT_TYPES,
  ...AUTOCOMPLETE_EVENT_TYPES,
  ...MODAL_EVENT_TYPES,
];

export function createEnterListener(deps: GiveawaysDeps): EventListener<GiveawaysConfig> {
  return {
    types: COMPONENT_EVENT_TYPES,
    async handler(event, ctx) {
      const builder = bindBuilder(deps);

      // The builder's own controls first: they share the component event with the Enter button,
      // and only one of the two owns any given custom id.
      if ('bound' in builder) {
        const handled = await handleBuilderPress(event, ctx, {
          ...builder.bound,
          ...(deps.applicationId ? { applicationId: deps.applicationId } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        });

        if (handled !== 'not-ours') return;
      }

      await handleEnter(event, ctx, deps);
    },
  };
}

export function createBuilderModalListener(deps: GiveawaysDeps): EventListener<GiveawaysConfig> {
  return {
    types: MODAL_EVENT_TYPES,
    async handler(event, ctx) {
      const builder = bindBuilder(deps);
      if ('unbound' in builder) return;

      await handleBuilderSubmit(event, ctx, {
        ...builder.bound,
        ...(deps.applicationId ? { applicationId: deps.applicationId } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
    },
  };
}

export function createGiveawayAutocompleteListener(
  deps: GiveawaysDeps,
): EventListener<GiveawaysConfig> {
  return {
    types: AUTOCOMPLETE_EVENT_TYPES,
    async handler(event, ctx) {
      await handleAutocomplete(event, ctx, deps);
    },
  };
}
