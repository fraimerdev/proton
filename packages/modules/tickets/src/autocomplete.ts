import {
  type AutocompleteChoice,
  type EventListener,
  type EventType,
  interactionRef,
  MAX_AUTOCOMPLETE_CHOICES,
  type ModuleContext,
  type ProtonEvent,
  readAutocompleteInteraction,
  respondAutocomplete,
} from '@proton/core';
import { MODULE_ID, type TicketsConfig } from './config.ts';
import type { TicketsDeps } from './deps.ts';

export const TICKET_AUTOCOMPLETE_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

export function panelChoices(config: TicketsConfig, query: string): AutocompleteChoice[] {
  const needle = query.trim().toLowerCase();

  return config.panels
    .filter(
      (panel) =>
        needle === '' ||
        panel.id.toLowerCase().includes(needle) ||
        panel.name.toLowerCase().includes(needle),
    )
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((panel) => ({ name: `${panel.name} (${panel.id})`.slice(0, 100), value: panel.id }));
}

export function typeChoices(config: TicketsConfig, query: string): AutocompleteChoice[] {
  const needle = query.trim().toLowerCase();

  return config.types
    .filter(
      (type) =>
        needle === '' ||
        type.id.toLowerCase().includes(needle) ||
        type.name.toLowerCase().includes(needle),
    )
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((type) => ({ name: `${type.name} (${type.id})`.slice(0, 100), value: type.id }));
}

export function responseChoices(config: TicketsConfig, query: string): AutocompleteChoice[] {
  const needle = query.trim().toLowerCase();

  return config.responses
    .filter(
      (response) =>
        needle === '' ||
        response.id.toLowerCase().includes(needle) ||
        response.label.toLowerCase().includes(needle),
    )
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((response) => ({ name: response.label.slice(0, 100), value: response.id }));
}

export async function handleAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
): Promise<AutocompleteChoice[] | null> {
  const facts = readAutocompleteInteraction(event);
  if (facts?.commandName !== 'ticket' || !facts.focused) return null;

  const answer: Record<string, (config: TicketsConfig, query: string) => AutocompleteChoice[]> = {
    panel: panelChoices,
    type: typeChoices,
    name: responseChoices,
  };

  const build = Object.hasOwn(answer, facts.focused.name) ? answer[facts.focused.name] : undefined;
  if (!build) return null;

  const choices = build(ctx.config, facts.focused.value);

  await ctx.executor.execute(
    respondAutocomplete(
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: facts.userId,
        interaction: interactionRef(facts),
        idempotencyKey: `${MODULE_ID}:${event.id}`,
      },
      choices,
    ),
  );

  return choices;
}

export function createTicketAutocompleteListener(_deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_AUTOCOMPLETE_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      await handleAutocomplete(event, ctx);
    },
  };
}
