import {
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

export async function handleAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<TicketsConfig>,
): Promise<'answered' | 'ignored'> {
  const facts = readAutocompleteInteraction(event);
  if (facts?.commandName !== 'ticket') return 'ignored';
  if (facts.focused === null || facts.focused.name !== 'panel') return 'ignored';

  const prefix = facts.focused.value.trim().toLowerCase();

  const choices = ctx.config.panels
    .filter((panel) => panel.id.startsWith(prefix))
    .slice(0, MAX_AUTOCOMPLETE_CHOICES)
    .map((panel) => ({ name: `${panel.name} (${panel.id})`.slice(0, 100), value: panel.id }));

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

  return 'answered';
}

export function createTicketAutocompleteListener(deps: TicketsDeps): EventListener<TicketsConfig> {
  return {
    types: TICKET_AUTOCOMPLETE_EVENT_TYPES,

    async handler(event, ctx) {
      if (!ctx.config.enabled) return;

      await handleAutocomplete(event, ctx);
      void deps;
    },
  };
}
