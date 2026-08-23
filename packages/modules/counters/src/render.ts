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

export interface CounterPlan {
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

export interface RefreshOutcome {
  total: number;

  updated: number;
  unchanged: number;
  unavailable: number;

  failures: CounterFailure[];
}

export const NO_COUNTERS =
  'No counter channels are set up in this server yet. Add them in the Proton dashboard, under ' +
  'Counters, and each one will start refreshing every 10 minutes.';

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function renderReport(outcome: RefreshOutcome): string {
  if (outcome.total === 0) return NO_COUNTERS;

  const parts = [`${outcome.updated} renamed`, `${outcome.unchanged} already correct`];
  if (outcome.unavailable > 0) parts.push(`${outcome.unavailable} skipped`);
  if (outcome.failures.length > 0) parts.push(`${outcome.failures.length} refused`);

  const lines = [`Checked ${plural(outcome.total, 'counter channel')} — ${parts.join(', ')}.`];

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

export function plan(config: CountersConfig, state: GuildState): CounterPlan {
  const edits: CounterEdit[] = [];
  const unchanged: string[] = [];
  const unavailable: string[] = [];

  for (const counter of config.counters) {
    const count = countFor(counter.source, state);
    if (count === null) {
      unavailable.push(counter.channelId);
      continue;
    }

    const to = renderName(counter.template, count);
    // A channel this snapshot has never seen has no name to compare against, so it is renamed
    // rather than assumed correct: one wasted edit beats a counter frozen at a stale number.
    const from = state.channels.get(counter.channelId)?.name ?? null;

    if (from === to) {
      unchanged.push(counter.channelId);
      continue;
    }

    edits.push({ channelId: counter.channelId, from, to });
  }

  return { edits, unchanged, unavailable };
}
