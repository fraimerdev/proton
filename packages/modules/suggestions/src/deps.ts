import type { SuggestionStore } from './store.ts';

export interface SuggestionsDeps {
  store?: SuggestionStore;

  applicationId?: string;
}

export interface BoundDeps {
  store: SuggestionStore;
  applicationId: string;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleSuggestionStore(db)',
  applicationId: "applicationId: the application's own id, from READY",
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Suggestions is enabled in this server but ${what}: the module was built without ` +
    `${unbound.join(', ')}. The process running modules must call createSuggestionsModule({ ` +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

// Both surfaces need the application id, not just the buttons: /suggest and /suggestion each defer
// and then follow up, because posting or editing a message is more than one round trip.
export function bindDeps(deps: SuggestionsDeps): BindResult<BoundDeps> {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.applicationId) unbound.push('applicationId');

  return deps.store && deps.applicationId
    ? { deps: { store: deps.store, applicationId: deps.applicationId } }
    : { unbound };
}
