import type { GuildStateStore, RateWindowStore } from '@proton/core';
import type { MaintenanceStore } from './maintenance.ts';

/**
 * Everything the breaker needs that `ModuleContext` cannot give it (§7).
 *
 * A module gets a guild id, its config, an executor and a logger — no Redis, no
 * database, no member lookups. So the ports are declared here and bound by
 * whatever process runs modules, exactly as `createLoggingModule({ store })`
 * binds its message-log store. Every one of them is optional so the manifest can
 * still be registered, rendered in the dashboard and typechecked with nothing
 * bound; what a module must never do is *pretend* to protect a guild it cannot
 * protect, which is what `describeUnbound` below exists to prevent.
 */
export interface AntinukeDeps {
  /**
   * The sliding-window counter. `RedisRateWindow` from `@proton/core` — the same
   * atomic Lua counter the rule engine uses, deliberately not a second one:
   * read-then-increment across two workers lets a burst through with every
   * worker seeing a count below the limit, which is precisely the concurrent
   * flood this module exists to catch.
   */
  rateWindow?: RateWindowStore;

  /** Where the time-boxed maintenance flag lives. `RedisMaintenanceStore`. */
  maintenance?: MaintenanceStore;

  /** The guild snapshot — read for the owner id and for role positions. */
  guildState?: GuildStateStore;

  /**
   * One member's role ids.
   *
   * The same shape as `ResolveContextDeps.fetchMemberRoles`, so the process
   * wiring this module binds the one function it already has rather than growing
   * a second way to answer the same question. A single-member fetch: never
   * Request Guild Members, which §10.4 caps at one per guild per 30 seconds.
   */
  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  /**
   * Proton's own user id.
   *
   * Not a nicety. Every action the executor takes appears in the audit log
   * attributed to the bot, so the ban the breaker itself performs arrives back
   * as a `member.banned` event — and without this the module would count its own
   * response as an attack and strip the roles off itself.
   */
  botUserId?: string;

  /** Injected so tests can pin the clock the maintenance window is judged by. */
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

/**
 * What to say when a guild has anti-nuke switched on and something destructive
 * just happened, but the module was never given what it needs to react.
 *
 * Named ports and the exact construction, because "anti-nuke is enabled and
 * nothing happened" is the single worst thing this module could do quietly.
 */
export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Anti-nuke is enabled in this server but is NOT protecting it: the module was built ' +
    `without ${unbound.join(', ')}. Destructive audit-log events are being read and ` +
    'discarded. The process running modules must call createAntinukeModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
