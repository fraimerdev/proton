/**
 * Where the fetched blocklist lives between refreshes.
 *
 * A port declared by the module rather than by `packages/core`, for the same
 * reason `MessageLogStore` is: §7 lets a module own storage but `ModuleContext`
 * has no way to hand it a connection, so whoever wires the module up binds the
 * implementation. See `createPhishingModule`.
 *
 * The cache is **global, not per guild**. One community list serves every
 * server, so keying it per guild would multiply the memory and the fetches by
 * the number of guilds to store identical bytes.
 */

export interface BlocklistStats {
  /** How many domains are currently cached. Zero means the module is degraded. */
  size: number;
  /** When the cache was last replaced, or null if it never has been. */
  refreshedAt: Date | null;
  /** Feed URLs that answered on that refresh. */
  feeds: string[];
  /** Feed URLs that did not, with the reason, from that refresh. */
  failures: { url: string; reason: string }[];
}

export interface BlocklistInstall {
  domains: readonly string[];
  refreshedAt: Date;
  feeds: readonly string[];
  failures: readonly { url: string; reason: string }[];
}

export interface BlocklistStore {
  /**
   * Replace the cached list, atomically.
   *
   * Atomic because the alternative — clear then repopulate — leaves a window in
   * which the list is empty or half-written, and every message handled in that
   * window silently goes unchecked. Implementations build the new set under a
   * staging key and swap it in.
   *
   * Callers must never pass an empty `domains`: an empty install is
   * indistinguishable from "every feed is down" once it is stored, so
   * `refreshBlocklist` refuses it upstream and implementations reject it here as
   * a programming error.
   */
  replace(install: BlocklistInstall): Promise<number>;

  /**
   * Which of `candidates` is blocked, or null.
   *
   * Takes the whole candidate list so an implementation can answer in one round
   * trip. Returns the matched entry — not a boolean — because the alert has to
   * name the domain, and re-deriving which candidate matched would mean matching
   * twice.
   */
  lookup(candidates: readonly string[]): Promise<string | null>;

  stats(): Promise<BlocklistStats>;
}
