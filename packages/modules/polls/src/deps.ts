import type { PollStore } from './store.ts';

export interface PollsDeps {
  store?: PollStore;

  applicationId?: string;
}

export type StoreBinding = { store: PollStore } | { unbound: string[] };

export type InteractiveBinding =
  | { store: PollStore; applicationId: string }
  | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzlePollStore(handle)',
  applicationId: "applicationId: the application's own id, from env.DISCORD_APPLICATION_ID",
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Polls is enabled in this server but ${what}: the module was built without ` +
    `${unbound.join(', ')}. The process running modules must call createPollsModule({ ` +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export function bindStore(deps: PollsDeps): StoreBinding {
  return deps.store ? { store: deps.store } : { unbound: ['store'] };
}

export function bindInteractive(deps: PollsDeps): InteractiveBinding {
  const { store, applicationId } = deps;
  if (store && applicationId) return { store, applicationId };

  return {
    unbound: [...(store ? [] : ['store']), ...(applicationId ? [] : ['applicationId'])],
  };
}
