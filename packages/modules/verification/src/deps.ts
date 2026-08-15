import type { GuildStateStore } from '@proton/core';
import type { QuarantineStore } from './store.ts';

export interface VerificationDeps {
  guildState?: GuildStateStore;

  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  quarantine?: QuarantineStore;

  now?(): number;
}

export interface BoundGateDeps {
  guildState: GuildStateStore;
}

export interface BoundQuarantineDeps extends BoundGateDeps {
  fetchMemberRoles(guildId: string, userId: string): Promise<string[] | null>;
  quarantine: QuarantineStore;
  now(): number;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  fetchMemberRoles: 'fetchMemberRoles: the same single-member lookup resolvePrecheckContext uses',
  quarantine: 'quarantine: new RedisQuarantineStore(redis)',
};

export function bindGateDeps(deps: VerificationDeps): BindResult<BoundGateDeps> {
  return deps.guildState ? { deps: { guildState: deps.guildState } } : { unbound: ['guildState'] };
}

export function bindQuarantineDeps(deps: VerificationDeps): BindResult<BoundQuarantineDeps> {
  const { guildState, fetchMemberRoles, quarantine } = deps;

  const unbound: string[] = [];
  if (!guildState) unbound.push('guildState');
  if (!fetchMemberRoles) unbound.push('fetchMemberRoles');
  if (!quarantine) unbound.push('quarantine');

  if (!guildState || !fetchMemberRoles || !quarantine) return { unbound };

  return {
    deps: { guildState, fetchMemberRoles, quarantine, now: deps.now ?? (() => Date.now()) },
  };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the verification module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createVerificationModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
