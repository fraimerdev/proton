import {
  interactionRef,
  MAX_AUTOCOMPLETE_CHOICE_LENGTH,
  MAX_AUTOCOMPLETE_CHOICES,
  type ModuleContext,
  type ProtonEvent,
  readAutocompleteInteraction,
  respondAutocomplete,
} from '@proton/core';
import { type GiveawaysConfig, MODULE_ID, plural } from './config.ts';
import { bindStore, describeUnbound, type GiveawaysDeps } from './deps.ts';
import type { Giveaway, GiveawayState } from './store.ts';

export const AUTOCOMPLETED_COMMAND = 'giveaway';
export const GIVEAWAY_OPTION = 'giveaway';

export type AutocompleteOutcome =
  | { action: 'ignored'; reason: string }
  | { action: 'answered'; count: number };

export function stateFor(subcommand: string | null): GiveawayState {
  if (subcommand === 'end') return 'running';
  if (subcommand === 'reroll') return 'ended';
  return 'any';
}

export function choiceFor(giveaway: Giveaway): { name: string; value: string } {
  const suffix = ` · ${plural(giveaway.winnerCount, 'winner')} · ${
    giveaway.endedAt === null ? 'running' : 'ended'
  }`;

  const room = MAX_AUTOCOMPLETE_CHOICE_LENGTH - suffix.length;
  const title =
    giveaway.title.length > room
      ? `${giveaway.title.slice(0, Math.max(1, room - 1))}…`
      : giveaway.title;

  return { name: `${title}${suffix}`, value: giveaway.id };
}

export async function handleAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<GiveawaysConfig>,
  deps: GiveawaysDeps,
): Promise<AutocompleteOutcome> {
  const facts = readAutocompleteInteraction(event);
  if (!facts) return { action: 'ignored', reason: 'unreadable interaction payload' };

  if (facts.commandName !== AUTOCOMPLETED_COMMAND) {
    return { action: 'ignored', reason: 'another module owns that command' };
  }

  if (facts.focused === null || facts.focused.name !== GIVEAWAY_OPTION) {
    return { action: 'ignored', reason: 'the focused option is not a giveaway' };
  }

  if (!ctx.config.enabled) return { action: 'ignored', reason: 'giveaways are switched off' };

  const bound = bindStore(deps);
  if ('unbound' in bound) {
    ctx.logger.error(describeUnbound('giveaway suggestions could not be read', bound.unbound), {
      guildId: ctx.guildId,
      moduleId: MODULE_ID,
    });
    return { action: 'ignored', reason: 'the giveaway store is unbound' };
  }

  const rows = await bound.bound.store.list({
    guildId: ctx.guildId,
    state: stateFor(facts.subcommand),
    limit: MAX_AUTOCOMPLETE_CHOICES,
    prefix: facts.focused.value,
  });

  // Answered even when empty: Discord shows "no options match" for an empty choice list, and
  // saying nothing leaves the member watching a spinner until the interaction expires.
  await ctx.executor.execute(
    respondAutocomplete(
      {
        guildId: ctx.guildId,
        moduleId: MODULE_ID,
        actorId: facts.userId,
        interaction: interactionRef(facts),
        idempotencyKey: `${MODULE_ID}:${event.id}`,
      },
      rows.map(choiceFor),
    ),
  );

  return { action: 'answered', count: rows.length };
}
