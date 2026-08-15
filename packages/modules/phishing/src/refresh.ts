import type { Logger } from '@proton/core';
import { type BlocklistFeedOptions, fetchBlocklist } from './feeds.ts';
import type { BlocklistStore } from './store.ts';

/**
 * The blocklist refresh (P2 §8: "phishing-link detection via community blocklist
 * feeds").
 *
 * One exported function rather than a job class, so the scheduler that ends up
 * running it — BullMQ today, `manifest.jobs` when a runner exists — is a
 * three-line wrapper and this stays testable without Redis or a queue. The same
 * split `runMessageLogMaintenance` uses.
 */

/** The module's own id for the recurring refresh, as declared in `manifest.jobs`. */
export const BLOCKLIST_REFRESH_JOB_ID = 'refresh-blocklist';

/**
 * Hourly, at 17 minutes past.
 *
 * Community feeds are static files served to every bot that uses them, and every
 * one of those bots writes `0 * * * *`. Offsetting the minute keeps Proton's
 * fleet off the top-of-the-hour thundering herd — free politeness towards a list
 * maintained by volunteers, and a lower chance of being rate limited into the
 * degraded path this module works so hard to survive.
 */
export const BLOCKLIST_REFRESH_CRON = '17 * * * *';

/**
 * A BullMQ queue name for the refresh, for whoever schedules it.
 *
 * No colon: BullMQ builds its keys as `bull:<queue>:<id>`, so a colon here would
 * nest a second namespace inside theirs. Same constraint `REVERSAL_QUEUE` calls
 * out in the worker.
 */
export const BLOCKLIST_QUEUE = 'proton-phishing-blocklist';

export interface RefreshBlocklistDeps extends BlocklistFeedOptions {
  store: BlocklistStore;
  logger: Logger;
  now?(): Date;
}

export interface RefreshOutcome {
  /** True only when a new list was actually written. */
  installed: boolean;
  /** Domains in the new list, or 0 when nothing was installed. */
  size: number;
  feedsSucceeded: number;
  feedsFailed: number;
  /** Present when `installed` is false — the sentence already written to the log. */
  reason?: string;
}

/**
 * Fetch every feed and install the union, unless there is nothing to install.
 *
 * The refusal to install an empty result is the single most important line in
 * this module. Every feed failing at once is exactly what a targeted attacker
 * would arrange before a raid, and it is also what an expired TLS certificate or
 * a GitHub outage looks like. If an empty result overwrote the cache, that
 * outage would silently switch phishing detection off across every server Proton
 * runs in, and nothing downstream could tell the difference between "no domains
 * are blocked" and "we could not find out which domains are blocked". So a
 * failed refresh keeps yesterday's list — stale coverage beats no coverage — and
 * says so at error level.
 *
 * Never throws. A refresh is a background tick; a rejection would only surface as
 * a BullMQ retry storm against a feed that is already struggling.
 */
export async function refreshBlocklist(deps: RefreshBlocklistDeps): Promise<RefreshOutcome> {
  const now = deps.now ?? ((): Date => new Date());

  const fetched = await fetchBlocklist({
    logger: deps.logger,
    ...(deps.feeds !== undefined ? { feeds: deps.feeds } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
    ...(deps.userAgent !== undefined ? { userAgent: deps.userAgent } : {}),
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  });

  const base = {
    feedsSucceeded: fetched.succeeded.length,
    feedsFailed: fetched.failed.length,
  };

  if (fetched.domains.length === 0) {
    const reason =
      `every phishing blocklist feed failed (${fetched.failed
        .map((failure) => `${failure.url}: ${failure.reason}`)
        .join('; ')}). The previously cached list is being kept rather than replaced with an ` +
      'empty one; phishing detection is running on a stale list, or on none at all if the ' +
      'cache has since expired.';

    deps.logger.error(`phishing blocklist refresh installed nothing — ${reason}`, {
      moduleId: 'phishing',
      failures: fetched.failed,
    });

    return { ...base, installed: false, size: 0, reason };
  }

  try {
    const size = await deps.store.replace({
      domains: fetched.domains,
      refreshedAt: now(),
      feeds: fetched.succeeded.map((feed) => feed.url),
      failures: fetched.failed,
    });

    // A partial refresh is worth saying out loud: coverage silently narrowed,
    // and the only place that fact exists is this line.
    if (fetched.failed.length > 0) {
      deps.logger.warn(
        `phishing blocklist refreshed from ${fetched.succeeded.length} of ` +
          `${fetched.succeeded.length + fetched.failed.length} feeds — coverage is reduced`,
        { moduleId: 'phishing', size, failures: fetched.failed },
      );
    } else {
      deps.logger.info('phishing blocklist refreshed', { moduleId: 'phishing', size });
    }

    return { ...base, installed: true, size };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    deps.logger.error(
      `phishing blocklist could not be cached: ${reason}. Detection is running on whatever ` +
        'was last cached, which may be nothing.',
      { moduleId: 'phishing' },
    );

    return { ...base, installed: false, size: 0, reason };
  }
}
