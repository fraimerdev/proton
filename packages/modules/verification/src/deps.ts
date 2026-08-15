import type { GuildStateStore } from '@proton/core';
import type { QuarantineStore } from './store.ts';

/**
 * Everything this module needs that `ModuleContext` cannot give it (§7).
 *
 * A module gets a guild id, its config, an executor and a logger — no Redis, no
 * database, no member lookups. So the ports are declared here and bound by
 * whatever process runs modules, exactly as `createLoggingModule({ store })`
 * binds its message-log store. Every one is optional so the manifest still
 * registers, renders in the dashboard and typechecks with nothing bound; what a
 * module must never do is quietly behave as though a control is in force when it
 * is not, which is what `describeUnbound` exists to prevent.
 */
export interface VerificationDeps {
  /**
   * The guild snapshot — read for role positions.
   *
   * Required by every path that grants or applies a role, because Discord
   * refuses to assign a role positioned at or above the bot's highest one and
   * the executor's prechecks do not currently catch that (see the blocker on
   * `createVerificationModule`). Without it the refusal would arrive as a bare
   * 403 from Discord after the attempt, naming no role and no remedy.
   */
  guildState?: GuildStateStore;

  /**
   * One member's role ids.
   *
   * The same shape as `ResolveContextDeps.fetchMemberRoles`, so the process
   * wiring this module binds the one function it already has rather than growing
   * a second way to answer the same question. A single-member fetch: never
   * Request Guild Members, which §10.4 caps at one per guild per 30 seconds.
   *
   * Only `/quarantine` needs it — the gate reads the joining member's roles off
   * the dispatch, and `/verify` needs no lookup at all.
   */
  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  /** Where prior roles are recorded. `RedisQuarantineStore`. */
  quarantine?: QuarantineStore;

  /** Injected so tests can pin the timestamp on a quarantine record. */
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

/** What the join gate and `/verify` need: role positions, and nothing else. */
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

/**
 * What to say when the module was asked to do something it was never given the
 * means to do.
 *
 * Named ports and the exact construction. "Verification is on and the member is
 * still ungated" has to be a sentence somebody can act on, not a silence.
 */
export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `${what} — the verification module was built without ${unbound.join(', ')}. ` +
    'The process running modules must call createVerificationModule({ ' +
    `${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}
