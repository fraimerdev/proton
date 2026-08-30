import type { GuildStateStore } from '@proton/core';
import type { CounterChannelStore } from './store.ts';

export interface CountersDeps {
  guildState?: GuildStateStore;

  // Only the counters whose channel Proton makes itself need this; one pointed at an existing
  // channel refreshes without it.
  channels?: CounterChannelStore;
}

const PORT_HINTS: Record<string, string> = {
  guildState: 'guildState: new RedisGuildStateStore(stateRedis)',
  channels: 'channels: new DrizzleCounterChannelStore(handle)',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Counter channels are enabled in this server but ${what} is NOT running: the module was ` +
    `built without ${unbound.join(', ')}, which is where the member, role and channel counts ` +
    `are read from. The process running modules must call createCountersModule({ ` +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type GuildStateBinding = { guildState: GuildStateStore } | { unbound: string[] };

export function bindGuildState(deps: CountersDeps): GuildStateBinding {
  return deps.guildState ? { guildState: deps.guildState } : { unbound: ['guildState'] };
}
