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
import { MODULE_ID, type RemindersConfig } from './config.ts';
import { bindStore, describeUnbound, type RemindersDeps } from './deps.ts';
import { reminderLabel } from './render.ts';

export const REMINDERS_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

const AUTOCOMPLETED_COMMAND = 'reminders';

const FOCUSED_OPTION = 'reminder';

export type AutocompleteOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'answered'; count: number };

export async function handleAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<RemindersConfig>,
  deps: RemindersDeps,
): Promise<AutocompleteOutcome> {
  const facts = readAutocompleteInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  if (facts.commandName !== AUTOCOMPLETED_COMMAND) {
    return { action: 'ignored', reason: 'another module owns that command' };
  }

  if (facts.focused === null || facts.focused.name !== FOCUSED_OPTION) {
    return { action: 'ignored', reason: 'the focused option is not a reminder' };
  }

  if (!ctx.config.enabled) return { action: 'ignored', reason: 'reminders is switched off' };

  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('reminder suggestions could not be read', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'ignored', reason: 'the reminder store is unbound' };
  }

  const search = facts.focused.value.trim();

  const pending = await bound.store.pending({
    guildId: ctx.guildId,
    userId: facts.userId,
    limit: MAX_AUTOCOMPLETE_CHOICES,
    ...(search.length === 0 ? {} : { search }),
  });

  const now = Date.now();

  // Answered even when empty: Discord shows "no options match" for an empty choice list, and
  // saying nothing at all leaves the member watching a spinner until the interaction expires.
  await ctx.executor.execute(
    respondAutocomplete(
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: facts.userId,
        interaction: interactionRef(facts),
        idempotencyKey: `${MODULE_ID}:${event.id}`,
      },
      pending.map((reminder) => ({ name: reminderLabel(reminder, now), value: reminder.id })),
    ),
  );

  return { action: 'answered', count: pending.length };
}

export function createRemindersAutocompleteListener(
  deps: RemindersDeps,
): EventListener<RemindersConfig> {
  return {
    types: REMINDERS_EVENT_TYPES,
    handler: async (event, ctx) => {
      await handleAutocomplete(event, ctx, deps);
    },
  };
}
