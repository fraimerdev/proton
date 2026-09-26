import type { GuildStateStore, ModuleAvailability, ProviderRegistry } from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { ApplicationStore } from './store.ts';

export type MemberRolesLookup = (
  guildId: string,
  userId: string,
) => Promise<string[] | 'absent' | null>;

export type MemberLookup = (
  guildId: string,
  userId: string,
) => Promise<
  | { state: 'member'; roleIds: string[]; joinedAt: number | null }
  | { state: 'absent' }
  | { state: 'unavailable' }
>;

export interface ApplicationsDeps {
  store?: ApplicationStore;

  applicationId?: string;
  dashboardUrl?: string;

  providers?: ProviderRegistry;
  availability?: ModuleAvailability;

  guildState?: Pick<GuildStateStore, 'get'>;
  placeholders?: PlaceholderEnvironment;

  memberRoles?: MemberRolesLookup;
  lookupMember?: MemberLookup;

  now?(): number;
}

export interface BoundApplicationsDeps {
  store: ApplicationStore;
  applicationId: string;
  dashboardUrl: string | null;
  providers: ProviderRegistry | null;
  availability: ModuleAvailability | null;
  guildState: Pick<GuildStateStore, 'get'> | null;
  placeholders: PlaceholderEnvironment | null;
  memberRoles: MemberRolesLookup | null;
  lookupMember: MemberLookup | null;
  now(): number;
}

export type BindResult<T> = { deps: T } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleApplicationStore(handle)',
  applicationId: "applicationId: the application's own id, from READY",
};

export function bindApplicationsDeps(deps: ApplicationsDeps): BindResult<BoundApplicationsDeps> {
  const { store, applicationId } = deps;

  const unbound: string[] = [];
  if (!store) unbound.push('store');
  if (!applicationId) unbound.push('applicationId');

  if (!store || !applicationId) return { unbound };

  return {
    deps: {
      store,
      applicationId,
      dashboardUrl: deps.dashboardUrl?.replace(/\/$/, '') ?? null,
      providers: deps.providers ?? null,
      availability: deps.availability ?? null,
      guildState: deps.guildState ?? null,
      placeholders: deps.placeholders ?? null,
      memberRoles: deps.memberRoles ?? null,
      lookupMember: deps.lookupMember ?? null,
      now: deps.now ?? (() => Date.now()),
    },
  };
}

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what}: the applications module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createApplicationsModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
