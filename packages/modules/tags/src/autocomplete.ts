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
import { MODULE_ID, TAG_NAME_MAX, type TagsConfig } from './config.ts';
import { bindStore, describeUnbound, type TagsDeps } from './deps.ts';

export const TAGS_EVENT_TYPES: EventType[] = ['interaction.autocomplete'];

const AUTOCOMPLETED_COMMANDS: ReadonlySet<string> = new Set(['tag', 'tags']);

const FOCUSED_OPTION = 'name';

export type AutocompleteOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'answered'; count: number };

export function normalisePrefix(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, TAG_NAME_MAX);
}

export async function handleAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<TagsConfig>,
  deps: TagsDeps,
): Promise<AutocompleteOutcome> {
  const facts = readAutocompleteInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  if (!AUTOCOMPLETED_COMMANDS.has(facts.commandName)) {
    return { action: 'ignored', reason: 'another module owns that command' };
  }

  if (facts.focused === null || facts.focused.name !== FOCUSED_OPTION) {
    return { action: 'ignored', reason: 'the focused option is not a tag name' };
  }

  if (!ctx.config.enabled) return { action: 'ignored', reason: 'tags is switched off' };

  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('tag suggestions could not be read', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'ignored', reason: 'the tag store is unbound' };
  }

  const names = await bound.store.suggest(
    ctx.guildId,
    normalisePrefix(facts.focused.value),
    MAX_AUTOCOMPLETE_CHOICES,
  );

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
      names.map((name) => ({ name, value: name })),
    ),
  );

  return { action: 'answered', count: names.length };
}

export function createTagsAutocompleteListener(deps: TagsDeps): EventListener<TagsConfig> {
  return {
    types: TAGS_EVENT_TYPES,
    handler: async (event, ctx) => {
      await handleAutocomplete(event, ctx, deps);
    },
  };
}
