import type { GuildState } from '@proton/core';
import type { AfkStore } from './store.ts';

export interface AfkDeps {
  store?: AfkStore;
  applicationId?: string;
  guildState?: { get(guildId: string): Promise<GuildState | null> };
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleAfkStore(db)',
  applicationId: 'applicationId: env.DISCORD_APPLICATION_ID',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `AFK is enabled in this server but ${what} is NOT running: the module was built without ` +
    `${unbound.join(', ')}. The process running modules must call ` +
    `createAfkModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: AfkStore } | { unbound: string[] };

export function bindStore(deps: AfkDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}
