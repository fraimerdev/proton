import type { EventListener, EventType } from '@proton/core';
import { handleAutocomplete } from './autocomplete.ts';
import { handleBuilderPress, handleBuilderSubmit } from './builder/interactions.ts';
import { type GiveawaysConfig, MODULE_ID } from './config.ts';
import type { GiveawaysDeps } from './deps.ts';
import { bindBuilder, clockOf } from './deps.ts';
import { handleEnter } from './interactions.ts';
import { armPatrols } from './schedule.ts';

export const COMPONENT_EVENT_TYPES: EventType[] = ['interaction.component'];

export const AUTOCOMPLETE_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

export const MODAL_EVENT_TYPES: EventType[] = ['interaction.modal'];

export const PATROL_EVENT_TYPES: EventType[] = ['guild.available', 'proton.config_changed'];

export const GIVEAWAYS_EVENT_TYPES: EventType[] = [
  ...COMPONENT_EVENT_TYPES,
  ...AUTOCOMPLETE_EVENT_TYPES,
  ...MODAL_EVENT_TYPES,
  ...PATROL_EVENT_TYPES,
];

// A due job for a switched-off module is dropped rather than deferred, so without re-arming on
// config_changed the patrols stop forever the first time an admin toggles Giveaways off and on.
export function createGiveawayPatrolListener(
  deps: GiveawaysDeps = {},
): EventListener<GiveawaysConfig> {
  return {
    types: PATROL_EVENT_TYPES,

    async handler(event, ctx) {
      if (event.type === 'proton.config_changed') {
        const payload = event.payload;
        const moduleId =
          typeof payload === 'object' && payload !== null
            ? (payload as { moduleId?: unknown }).moduleId
            : undefined;

        if (moduleId !== MODULE_ID) return;
      }

      await armPatrols(ctx, deps, clockOf(deps)());
    },
  };
}

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
