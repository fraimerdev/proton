import type { MemberContextLoader, ModuleAvailability, ProviderRegistry } from '@proton/core';
import type { DraftStore } from './builder/state.ts';
import type { DirtyCounts } from './counter.ts';
import type { EntryBucket } from './entry.ts';
import type { GiveawayStore } from './store.ts';

export interface GiveawaysDeps {
  store?: GiveawayStore;

  /** Draw-time member facts. Without it a draw falls back to the join-time snapshot. */
  members?: MemberContextLoader;

  /** Shared by every worker, so the ≤1 edit per window holds across a whole deployment. */
  dirty?: DirtyCounts;

  /** Rejects button spam before any database work (GIVEAWAYS.md §6). */
  bucket?: EntryBucket;

  providers?: ProviderRegistry;

  /** Where a half-built giveaway lives between button presses. */
  drafts?: DraftStore;

  /** Whether a provider's owning module is on for a guild, so the picker only offers usable ones. */
  availability?: ModuleAvailability;

  applicationId?: string;
  now?: () => number;
  newSeed?: () => string;
}

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleGiveawayStore(db)',
  members: 'members: new BulkMemberContextLoader(rest)',
  dirty: 'dirty: new RedisDirtyCounts(redis)',
  bucket: 'bucket: new RedisEntryBucket(redis)',
  providers: 'providers: registry.providers()',
  drafts: 'drafts: new RedisDraftStore(redis)',
  availability: 'availability: { isEnabled: (guildId, moduleId) => config.get(...).enabled }',
  applicationId: 'applicationId: env.DISCORD_APPLICATION_ID',
};

export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Giveaways is enabled in this server but ${what} is NOT running: the module was built ` +
    `without ${unbound.join(', ')}. The process running modules must call ` +
    `createGiveawaysModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type BindResult<T> = { bound: T } | { unbound: string[] };

export interface BoundStore {
  store: GiveawayStore;
}

export function bindStore(deps: GiveawaysDeps): BindResult<BoundStore> {
  return deps.store ? { bound: { store: deps.store } } : { unbound: ['store'] };
}

export interface BoundEntry {
  store: GiveawayStore;
  providers: ProviderRegistry;
  applicationId: string;
}

export function bindEntry(deps: GiveawaysDeps): BindResult<BoundEntry> {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.providers) unbound.push('providers');
  if (!deps.applicationId) unbound.push('applicationId');

  if (!deps.store || !deps.providers || !deps.applicationId) return { unbound };

  return {
    bound: {
      store: deps.store,
      providers: deps.providers,
      applicationId: deps.applicationId,
    },
  };
}

export interface BoundDraw {
  store: GiveawayStore;
  providers: ProviderRegistry;
}

export function bindDraw(deps: GiveawaysDeps): BindResult<BoundDraw> {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.providers) unbound.push('providers');

  if (!deps.store || !deps.providers) return { unbound };

  return { bound: { store: deps.store, providers: deps.providers } };
}

export interface BoundBuilder {
  store: GiveawayStore;
  providers: ProviderRegistry;
  drafts: DraftStore;
  availability: ModuleAvailability;
}

export function bindBuilder(deps: GiveawaysDeps): BindResult<BoundBuilder> {
  const unbound: string[] = [];
  if (!deps.store) unbound.push('store');
  if (!deps.providers) unbound.push('providers');
  if (!deps.drafts) unbound.push('drafts');
  if (!deps.availability) unbound.push('availability');

  if (!deps.store || !deps.providers || !deps.drafts || !deps.availability) return { unbound };

  return {
    bound: {
      store: deps.store,
      providers: deps.providers,
      drafts: deps.drafts,
      availability: deps.availability,
    },
  };
}

export function clockOf(deps: GiveawaysDeps): () => number {
  return deps.now ?? Date.now;
}
