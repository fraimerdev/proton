import {
  type EventListener,
  type EventType,
  interactionRef,
  type ModuleContext,
  type ProtonEvent,
  readAutocompleteInteraction,
  respondAutocomplete,
} from '@proton/core';
import { REASON_OPTION } from '../commands/member.ts';
import type { ModerationConfig } from '../config.ts';
import type { ModerationDeps } from '../deps.ts';
import { MODULE_ID } from '../perform.ts';
import { reasonChoices } from '../punish/reasons.ts';
import { send } from './respond.ts';

export const REASON_AUTOCOMPLETE_TYPES: EventType[] = ['interaction.autocomplete'];

const PUNISHING_SUBCOMMANDS: Readonly<Record<string, string | null>> = {
  ban: 'add',
  kick: null,
  timeout: 'add',
  warn: 'add',
};

export async function answerReasonAutocomplete(
  event: ProtonEvent,
  ctx: ModuleContext<ModerationConfig>,
): Promise<boolean> {
  const facts = readAutocompleteInteraction(event);
  if (!facts || facts.focused?.name !== REASON_OPTION) return false;

  if (!Object.hasOwn(PUNISHING_SUBCOMMANDS, facts.commandName)) return false;
  if (facts.subcommand !== PUNISHING_SUBCOMMANDS[facts.commandName]) return false;

  const choices = ctx.config.enabled ? reasonChoices(ctx.config.punish, facts.focused.value) : [];

  // Answered even when empty: silence leaves the moderator watching a spinner until it expires.
  await send(
    ctx,
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

  return true;
}

export function createReasonAutocompleteListener(
  _deps: ModerationDeps,
): EventListener<ModerationConfig> {
  return {
    types: REASON_AUTOCOMPLETE_TYPES,
    async handler(event, ctx) {
      await answerReasonAutocomplete(event, ctx);
    },
  };
}
