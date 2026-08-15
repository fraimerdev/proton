import type { MemberXpStore } from './store.ts';
import type { VoiceSessionStore } from './voice-session.ts';

/**
 * What `ModuleContext` cannot supply (§7).
 *
 * A module is handed a guild id, its config, an executor, a logger and — since
 * slice 3.A — a narrow publish port. No database, no Redis. So both stores are
 * bound by whatever process runs modules, exactly as `createLoggingModule({
 * store })` binds its message log and `createPhishingModule({ blocklist })` its
 * cache. Every port is optional so the manifest still registers, renders in the
 * dashboard and typechecks with nothing bound — `apps/api` and the dashboard
 * build these manifests with no infrastructure in reach at all.
 *
 * What the module must never do is stay quiet about being unable to do its job,
 * which `describeUnbound` exists to prevent (§1).
 */
export interface LevelingDeps {
  /** `DrizzleMemberXpStore` from `@proton/db`, constructed with the curve. */
  xp?: MemberXpStore;

  /** `RedisVoiceSessionStore` from this package. Only voice XP needs it. */
  sessions?: VoiceSessionStore;

  /**
   * The clock, for the paths that have no event to take a time from.
   *
   * Listeners never use it — they use `event.occurredAt`, so a replay and a
   * backlog give the same answer as live traffic. Commands have no such
   * timestamp, and this is what a test pins instead of the machine's clock.
   */
  now?: () => number;

  /**
   * The per-message XP roll. Injected only so tests are deterministic; nothing
   * in production should pass it.
   */
  random?: () => number;
}

const PORT_HINTS: Record<string, string> = {
  xp: 'xp: new DrizzleMemberXpStore(db, { levelForXp, maxXp: MAX_XP })',
  sessions: 'sessions: new RedisVoiceSessionStore(redis)',
};

/**
 * What to say when a guild has leveling switched on and something happened, but
 * nothing was bound.
 *
 * Names the ports and the exact construction. "Leveling is enabled and nobody is
 * gaining XP" is the failure §1 and §7 exist to eliminate, and it is
 * indistinguishable from a quiet server unless something says so.
 */
export function describeUnbound(what: string, unbound: readonly string[]): string {
  return (
    `Leveling is enabled in this server but ${what} is NOT running: the module was built ` +
    `without ${unbound.join(', ')}. The process running modules must call ` +
    `createLevelingModule({ ${unbound.map((port) => PORT_HINTS[port] ?? port).join(', ')} }).`
  );
}

export type XpBinding = { xp: MemberXpStore } | { unbound: string[] };

export function bindXp(deps: LevelingDeps): XpBinding {
  return deps.xp ? { xp: deps.xp } : { unbound: ['xp'] };
}

export type VoiceBinding =
  | { xp: MemberXpStore; sessions: VoiceSessionStore }
  | { unbound: string[] };

export function bindVoice(deps: LevelingDeps): VoiceBinding {
  const unbound: string[] = [];
  if (!deps.xp) unbound.push('xp');
  if (!deps.sessions) unbound.push('sessions');

  if (!deps.xp || !deps.sessions) return { unbound };
  return { xp: deps.xp, sessions: deps.sessions };
}

/** Every path that has no event clock reads the time through here. */
export function clockOf(deps: LevelingDeps): () => number {
  return deps.now ?? Date.now;
}
