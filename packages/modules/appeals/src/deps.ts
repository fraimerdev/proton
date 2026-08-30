import type { BlockedMemberStore } from '@proton/core';
import type { AppealStore } from './store.ts';

export interface AppealsDeps {
  store?: AppealStore;

  applicationId?: string;

  blocked?: BlockedMemberStore;

  now?(): number;
}

export interface BoundAppealsDeps {
  store: AppealStore;
  applicationId: string;
  now(): number;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleAppealStore(handle)',
  applicationId: "applicationId: the application's own id, from READY",
  blocked: 'blocked: new DrizzleBlockedMemberStore(handle)',
};

export function bindAppealsDeps(deps: AppealsDeps): BindResult<BoundAppealsDeps> {
  const { store, applicationId } = deps;

  const unbound: string[] = [];
  if (!store) unbound.push('store');
  if (!applicationId) unbound.push('applicationId');

  if (!store || !applicationId) return { unbound };

  return { deps: { store, applicationId, now: deps.now ?? (() => Date.now()) } };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the appeals module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createAppealsModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
