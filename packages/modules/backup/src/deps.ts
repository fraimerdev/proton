import { newId } from '@proton/core';
import type { GuildLayout } from './snapshot.ts';
import type { BackupStore } from './store.ts';

/**
 * Everything this module needs that `ModuleContext` cannot give it (§7).
 *
 * A module gets a guild id, its config, an executor and a logger — no database
 * and no view of the server's structure. So the ports are declared here and
 * bound by whatever process runs modules, exactly as `createLoggingModule({
 * store })` binds its message-log store. Both are optional so the manifest can
 * still be registered, rendered in the dashboard and typechecked with nothing
 * bound; what must never happen is a `/backup create` that reports success
 * without a snapshot existing anywhere.
 */
export interface BackupDeps {
  /** Where snapshots go. `DrizzleBackupStore` from this package. */
  store?: BackupStore;

  /**
   * The guild's channels and roles as they are right now.
   *
   * **Must be the gateway's view**, carrying obfuscated channels with their
   * `CHANNEL_OBFUSCATED` flag intact. From 16 Nov 2026 `GET /guilds/{id}/channels`
   * omits those channels entirely (§10.1), so a layout sourced from it cannot
   * count what it is missing — which is why `GuildLayout` carries its own
   * provenance and why `planRestore` refuses a REST-sourced one outright.
   *
   * Returns null when the process has no layout for the guild yet; the caller
   * says so rather than writing an empty backup.
   */
  readLayout?(guildId: string): Promise<GuildLayout | null>;

  /** Injected so tests can pin the instant a snapshot claims to be from. */
  now?(): number;

  /** Injected so a test can assert on a known backup id. */
  newBackupId?(): string;
}

export interface BoundBackupDeps {
  store: BackupStore;
  readLayout(guildId: string): Promise<GuildLayout | null>;
  now(): number;
  newBackupId(): string;
}

export type BindResult = { deps: BoundBackupDeps } | { unbound: string[] };

const PORT_HINTS: Record<string, string> = {
  store: 'store: new DrizzleBackupStore(dbHandle)',
  readLayout: 'readLayout: the gateway-derived channel and role list for the guild',
};

export function bindDeps(deps: BackupDeps): BindResult {
  const { store, readLayout } = deps;

  const unbound: string[] = [];
  if (!store) unbound.push('store');
  if (!readLayout) unbound.push('readLayout');

  if (!store || !readLayout) return { unbound };

  return {
    deps: {
      store,
      readLayout,
      now: deps.now ?? (() => Date.now()),
      newBackupId: deps.newBackupId ?? newId,
    },
  };
}

/**
 * What to say when an admin asks for a backup and the module was never given
 * what it needs to take one.
 *
 * Names the ports and the exact construction. "It said it worked" about a backup
 * that does not exist is the worst outcome this module has, because the guild
 * only finds out after it has been nuked.
 */
export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Backups are enabled in this server but Proton cannot take one: this deployment was started ' +
    `without ${unbound.join(', ')}, so there is nowhere to read the server's structure from or ` +
    'nowhere to write it to. Nothing has been saved. Whoever runs the bot needs to call ' +
    `createBackupModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
