import type { TagStore } from './store.ts';

export interface TagsDeps {
  store?: TagStore;
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleTagStore(db)',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Tags is enabled in this server but ${what} is NOT running: the module was built without ` +
    `${unbound.join(', ')}. The process running modules must call createTagsModule({ ` +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type StoreBinding = { store: TagStore } | { unbound: string[] };

export function bindStore(deps: TagsDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}
