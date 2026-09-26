import {
  type AutocompleteChoice,
  MAX_AUTOCOMPLETE_CHOICE_LENGTH,
  MAX_AUTOCOMPLETE_CHOICES,
} from '@proton/core';
import { clipGraphemes } from '@proton/core/placeholders';
import type { PredefinedReason } from './config.ts';

interface WithReasons {
  reasons: readonly PredefinedReason[];
}

export function findReason(config: WithReasons, raw: string): PredefinedReason | null {
  const token = raw.trim().toLowerCase();
  if (token === '') return null;

  return (
    config.reasons.find(
      (reason) =>
        reason.id.toLowerCase() === token ||
        reason.aliases.some((alias) => alias.toLowerCase() === token),
    ) ?? null
  );
}

export function expandReason(config: WithReasons, raw: string): string {
  const trimmed = raw.trim();
  return findReason(config, trimmed)?.reason ?? trimmed;
}

function choiceName(reason: string): string {
  if (reason.length <= MAX_AUTOCOMPLETE_CHOICE_LENGTH) return reason;
  return `${clipGraphemes(reason, MAX_AUTOCOMPLETE_CHOICE_LENGTH - 1)}…`;
}

// Past 100 characters Discord refuses the choice; expandReason maps the alias or id back.
function choiceValue(reason: PredefinedReason): string {
  if (reason.reason.length <= MAX_AUTOCOMPLETE_CHOICE_LENGTH) return reason.reason;
  return reason.aliases[0] ?? reason.id;
}

function matches(reason: PredefinedReason, typed: string): boolean {
  if (typed === '') return true;

  return (
    reason.reason.toLowerCase().includes(typed) ||
    reason.id.toLowerCase().startsWith(typed) ||
    reason.aliases.some((alias) => alias.toLowerCase().startsWith(typed))
  );
}

export function reasonChoices(config: WithReasons, typed: string): AutocompleteChoice[] {
  const needle = typed.trim().toLowerCase();
  const seen = new Set<string>();
  const choices: AutocompleteChoice[] = [];

  for (const reason of config.reasons) {
    if (!matches(reason, needle)) continue;

    const value = choiceValue(reason);
    if (seen.has(value)) continue;
    seen.add(value);

    choices.push({ name: choiceName(reason.reason), value });
    if (choices.length === MAX_AUTOCOMPLETE_CHOICES) break;
  }

  return choices;
}
