import { newId } from '@proton/core';
import type { GuildLayout } from './snapshot.ts';
import type { BackupStore } from './store.ts';

export interface BackupDeps {
  store?: BackupStore;

  readLayout?(guildId: string): Promise<GuildLayout | null>;

  now?(): number;

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

export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Backups are enabled in this server but Proton cannot take one: this deployment was started ' +
    `without ${unbound.join(', ')}, so there is nowhere to read the server's structure from or ` +
    'nowhere to write it to. Nothing has been saved. Whoever runs the bot needs to call ' +
    `createBackupModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
