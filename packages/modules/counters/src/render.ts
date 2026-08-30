import type { ChannelState, GuildState } from '@proton/core';
import {
  CHANNEL_NAME_MAX,
  COUNT_PLACEHOLDER,
  type CounterSource,
  type CountersConfig,
} from './config.ts';

const CATEGORY_TYPE = 4;

const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

export interface CounterEdit {
  channelId: string;

  from: string | null;
  to: string;
}

export interface CounterCreation {
  counterId: string;
  name: string;
}

export interface CounterPlan {
  creations: CounterCreation[];
  edits: CounterEdit[];

  unchanged: string[];
  unavailable: string[];
}

export function renderName(template: string, count: number): string {
  return template.split(COUNT_PLACEHOLDER).join(String(count)).slice(0, CHANNEL_NAME_MAX);
}

function countable(channel: ChannelState): boolean {
  if (channel.type === undefined) return true;
  return channel.type !== CATEGORY_TYPE && !THREAD_TYPES.has(channel.type);
}

export function countFor(source: CounterSource, state: GuildState): number | null {
  switch (source) {
    case 'members':
      return state.memberCount ?? null;
    case 'roles':
      return [...state.roles.keys()].filter((roleId) => roleId !== state.everyoneRoleId).length;
    case 'channels':
      return [...state.channels.values()].filter(countable).length;
  }
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
  'No counter channels are set up in this server yet. Add them in the Proton dashboard, under ' +
  'Counter channels, and each one will start refreshing every 10 minutes.';

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function renderReport(outcome: RefreshOutcome): string {
  if (outcome.total === 0) return NO_COUNTERS;

  const parts = [`${outcome.updated} renamed`, `${outcome.unchanged} already correct`];
  if (outcome.created > 0) parts.unshift(`${outcome.created} created`);
  if (outcome.unavailable > 0) parts.push(`${outcome.unavailable} skipped`);

  const refused = outcome.failures.length + outcome.creationFailures.length;
  if (refused > 0) parts.push(`${refused} refused`);

  const lines = [`Checked ${plural(outcome.total, 'counter channel')} — ${parts.join(', ')}.`];

  for (const channelId of outcome.unlocked) {
    lines.push(
      `I made <#${channelId}> but could not stop members joining it — that needs the Manage ` +
        'Roles permission. Deny Connect on it yourself, or grant Proton Manage Roles and remove ' +
        'and re-add the counter.',
    );
  }

  for (const failure of outcome.creationFailures) {
    lines.push(`I could not make the channel for “${failure.name}”: ${failure.humanReason}`);
  }

  if (outcome.unavailable > 0) {
    lines.push(
      `I have no member count cached for this server yet, so ${plural(outcome.unavailable, 'counter')} ` +
        'reading it were left alone rather than renamed to 0. It arrives the next time Proton ' +
        'connects to Discord.',
    );
  }

  for (const failure of outcome.failures) {
    lines.push(`<#${failure.channelId}> was not renamed: ${failure.humanReason}`);
  }

  return lines.join('\n');
}

export function plan(
  config: CountersConfig,
  state: GuildState,
  owned: ReadonlyMap<string, string> = new Map(),
): CounterPlan {
  const creations: CounterCreation[] = [];
  const edits: CounterEdit[] = [];
  const unchanged: string[] = [];
  const unavailable: string[] = [];

  for (const counter of config.counters) {
    const channelId = counter.channelId ?? owned.get(counter.id);

    const count = countFor(counter.source, state);
    if (count === null) {
      // Counted before created, so a counter Proton owns is never born showing the wrong number.
      unavailable.push(channelId ?? counter.id);
      continue;
    }

    const to = renderName(counter.template, count);

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

  return { creations, edits, unchanged, unavailable };
}
