import type { GuildStateStore } from '@proton/core';
import type { TicketStore } from './store.ts';

export interface TicketsDeps {
  store?: TicketStore;

  applicationId?: string;

  botUserId?: string;

  guildState?: GuildStateStore;
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleTicketStore(db)',
  applicationId: 'applicationId: env.DISCORD_APPLICATION_ID',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Tickets is enabled in this server but ${what} is NOT running: the module was built without ` +
    `${unbound.join(', ')}. The process running modules must call createTicketsModule({ ` +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: TicketStore } | { unbound: string[] };

export function bindStore(deps: TicketsDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}

export type ButtonBinding = { store: TicketStore; applicationId: string } | { unbound: string[] };

export function bindButton(deps: TicketsDeps): ButtonBinding {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.applicationId) unbound.push('applicationId');

  if (!deps.store || !deps.applicationId) return { unbound };
  return { store: deps.store, applicationId: deps.applicationId };
}
