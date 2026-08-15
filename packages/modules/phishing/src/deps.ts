import type { BlocklistStore } from './store.ts';

/**
 * What `ModuleContext` cannot supply (§7).
 *
 * A module is handed a guild id, its config, an executor and a logger — no
 * Redis. So the blocklist cache is a port bound by whatever process runs
 * modules, exactly as `createLoggingModule({ store })` binds its message log.
 * Optional, so the manifest still registers, renders in the dashboard and
 * typechecks with nothing bound; what the module must never do is stay quiet
 * about being unable to do its job, which `describeUnbound` exists to prevent.
 */
export interface PhishingDeps {
  /** The cached community list. `RedisBlocklistStore` from this package. */
  blocklist?: BlocklistStore;

  /**
   * Proton's own user id.
   *
   * Load-bearing, not decorative. The alert this module posts names the domain
   * that matched, so the alert is itself a message containing a blocklisted
   * domain. Without a way to recognise its own messages, Proton would match its
   * own alert, act, alert again, and spin until the channel is full or it has
   * timed itself out. Every message from this id is skipped before its content
   * is even read.
   */
  botUserId?: string;
}

export interface BoundPhishingDeps {
  blocklist: BlocklistStore;
  botUserId: string;
}

const PORT_HINTS: Record<string, string> = {
  blocklist: 'blocklist: new RedisBlocklistStore(redis)',
  botUserId: "botUserId: the application's own user id, from READY",
};

export type BindResult = { deps: BoundPhishingDeps } | { unbound: string[] };

export function bindDeps(deps: PhishingDeps): BindResult {
  const { blocklist, botUserId } = deps;

  const unbound: string[] = [];
  if (!blocklist) unbound.push('blocklist');
  if (!botUserId) unbound.push('botUserId');

  if (!blocklist || !botUserId) return { unbound };
  return { deps: { blocklist, botUserId } };
}

/**
 * What to say when a guild has the module switched on and a message arrived, but
 * nothing was bound.
 *
 * Names the ports and the exact construction. "Phishing protection is enabled
 * and nothing happened" is the failure §1 and §7 exist to eliminate, and it is
 * indistinguishable from "no phishing was posted" unless something says so.
 */
export function describeUnbound(unbound: readonly string[]): string {
  return (
    'Phishing detection is enabled in this server but is NOT running: the module was built ' +
    `without ${unbound.join(', ')}. Messages are being read and discarded unchecked. The ` +
    `process running modules must call createPhishingModule({ ${unbound
      .map((port) => PORT_HINTS[port] ?? port)
      .join(', ')} }).`
  );
}
