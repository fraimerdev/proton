import type { GuildStateStore, RateWindowStore } from '@proton/core';
import type { MaintenanceStore } from './maintenance.ts';

export interface AntinukeDeps {
  rateWindow?: RateWindowStore;

  maintenance?: MaintenanceStore;

  guildState?: GuildStateStore;

  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  botUserId?: string;

  now?(): number;
}

export interface BoundAntinukeDeps {
  rateWindow: RateWindowStore;
  maintenance: MaintenanceStore;
  guildState: GuildStateStore;
  fetchMemberRoles(guildId: string, userId: string): Promise<string[] | null>;
  botUserId: string;
  now(): number;
}

const PORT_HINTS: Record<string, string> = {
  rateWindow: 'rateWindow: new RedisRateWindow(redis)',
  maintenance: 'maintenance: new RedisMaintenanceStore(redis)',
  guildState: 'guildState: new RedisGuildStateStore(redis)',
  fetchMemberRoles: 'fetchMemberRoles: the same single-member lookup resolvePrecheckContext uses',
  botUserId: "botUserId: the application's own user id, from READY",
};

export type BindResult = { deps: BoundAntinukeDeps } | { unbound: string[] };

export function bindDeps(deps: AntinukeDeps): BindResult {
  const { rateWindow, maintenance, guildState, fetchMemberRoles, botUserId } = deps;

  const unbound: string[] = [];
  if (!rateWindow) unbound.push('rateWindow');
  if (!maintenance) unbound.push('maintenance');
  if (!guildState) unbound.push('guildState');
  if (!fetchMemberRoles) unbound.push('fetchMemberRoles');
  if (!botUserId) unbound.push('botUserId');

  if (!rateWindow || !maintenance || !guildState || !fetchMemberRoles || !botUserId) {
    return { unbound };
  }

  return {
    deps: {
      rateWindow,
      maintenance,
      guildState,
      fetchMemberRoles,
      botUserId,
      now: deps.now ?? (() => Date.now()),
    },
  };
}

export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Anti-nuke is enabled in this server but is NOT protecting it: the module was built ' +
    `without ${unbound.join(', ')}. Destructive audit-log events are being read and ` +
    'discarded. The process running modules must call createAntinukeModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
