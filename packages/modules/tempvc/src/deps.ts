import type { GuildStateStore } from '@proton/core';
import type { TempVcStore } from './store.ts';

export interface TempVcDeps {
  store?: TempVcStore;

  guildState?: GuildStateStore;
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new RedisTempVcStore(redis)',
  guildState: 'guildState: new RedisGuildStateStore(stateRedis)',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Temporary voice channels are enabled in this server but ${what} is NOT running: the module ` +
    `was built without ${unbound.join(', ')}. The process running modules must call ` +
    `createTempVcModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: TempVcStore } | { unbound: string[] };

export function bindStore(deps: TempVcDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}
