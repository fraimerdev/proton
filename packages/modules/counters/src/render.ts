import type { GuildState } from '@proton/core';
import type { TemplateDiagnostic } from '@proton/core/placeholders';
import type { CountersConfig } from './config.ts';
import type { CounterSource } from './constants.ts';
import { countFor, renderCounterName } from './placeholders.ts';

export interface CounterEdit {
  channelId: string;

  from: string | null;
  to: string;
}

export interface CounterCreation {
  counterId: string;
  name: string;
}

export interface BlankCounter {
  counterId: string;
  channelId: string | null;
  template: string;
  humanReason: string;
}

export interface CounterPlan {
  creations: CounterCreation[];
  edits: CounterEdit[];

  unchanged: string[];
  unavailable: string[];
  blank: BlankCounter[];
}

export function renderName(
  template: string,
  source: CounterSource,
  state: GuildState,
  now: number,
): string {
  return renderCounterName(template, { source, state }, now).output;
}

function blankReason(diagnostics: readonly TemplateDiagnostic[]): string {
  return [
    'its name is empty once the placeholders are filled in, and Discord needs a channel name of ' +
      '1 to 100 characters.',
    ...diagnostics
      .filter((diagnostic) => diagnostic.code !== 'empty_channel_name')
      .map((diagnostic) => diagnostic.message),
  ].join(' ');
}

export interface CounterFailure {
  channelId: string;
  humanReason: string;
}

export interface CreationFailure {
  name: string;
  humanReason: string;
}

export interface RefreshOutcome {
  total: number;

  created: number;
  updated: number;
  unchanged: number;
  unavailable: number;

  // Channels Proton made but could not stop members joining, which needs Manage Roles.
  unlocked: string[];

  failures: CounterFailure[];
  creationFailures: CreationFailure[];
}

export const NO_COUNTERS =
  'No counter channels are set up in this server yet. Add one on the Counters page of the ' +
  'Proton dashboard.';

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Refusals named in the report do not make a refresh red: one counter left showing the right
// number is the thing the invoker asked for.
export function refreshSucceeded(outcome: RefreshOutcome): boolean {
  return outcome.created + outcome.updated + outcome.unchanged > 0;
}

export function renderReport(outcome: RefreshOutcome): string {
  if (outcome.total === 0) return NO_COUNTERS;

  const parts = [`${outcome.updated} renamed`, `${outcome.unchanged} already correct`];
  if (outcome.created > 0) parts.unshift(`${outcome.created} created`);
  if (outcome.unavailable > 0) parts.push(`${outcome.unavailable} skipped`);

  const failed = outcome.failures.length + outcome.creationFailures.length;
  if (failed > 0) parts.push(`${failed} failed`);

  const lines = [`Checked ${plural(outcome.total, 'counter channel')}: ${parts.join(', ')}.`];

  for (const channelId of outcome.unlocked) {
    lines.push(
      `I created <#${channelId}>, but couldn't stop members joining it because I'm missing ` +
        'Manage Roles. Deny Connect on it yourself, or give me Manage Roles before you add more ' +
        'counters.',
    );
  }

  for (const failure of outcome.creationFailures) {
    lines.push(`Couldn't set up the channel for “${failure.name}”: ${failure.humanReason}`);
  }

  if (outcome.unavailable > 0) {
    lines.push(
      `I don't have this server's member count yet, so I left ${plural(outcome.unavailable, 'counter')} ` +
        'that use it alone instead of setting them to 0. It arrives the next time I connect to ' +
        'Discord.',
    );
  }

  for (const failure of outcome.failures) {
    lines.push(`Couldn't rename <#${failure.channelId}>: ${failure.humanReason}`);
  }

  return lines.join('\n');
}

export function plan(
  config: CountersConfig,
  state: GuildState,
  owned: ReadonlyMap<string, string> = new Map(),
  now: number = Date.now(),
): CounterPlan {
  const creations: CounterCreation[] = [];
  const edits: CounterEdit[] = [];
  const unchanged: string[] = [];
  const unavailable: string[] = [];
  const blank: BlankCounter[] = [];

  for (const counter of config.counters) {
    const channelId = counter.channelId ?? owned.get(counter.id);

    if (countFor(counter.source, state) === null) {
      // Counted before created, so a counter Proton owns is never born showing the wrong number.
      unavailable.push(channelId ?? counter.id);
      continue;
    }

    const rendered = renderCounterName(counter.template, { source: counter.source, state }, now);
    const to = rendered.output;

    if (to === '') {
      blank.push({
        counterId: counter.id,
        channelId: channelId ?? null,
        template: counter.template,
        humanReason: blankReason(rendered.diagnostics),
      });
      continue;
    }

    if (channelId === undefined) {
      creations.push({ counterId: counter.id, name: to });
      continue;
    }

    // A channel this snapshot has never seen has no name to compare against, so it is renamed
    // rather than assumed correct: one wasted edit beats a counter frozen at a stale number.
    const from = state.channels.get(channelId)?.name ?? null;

    if (from === to) {
      unchanged.push(channelId);
      continue;
    }

    edits.push({ channelId, from, to });
  }

  return { creations, edits, unchanged, unavailable, blank };
}
