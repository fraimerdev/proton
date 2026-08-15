import type { Logger } from '@proton/core';
import { type BlocklistFeedOptions, fetchBlocklist } from './feeds.ts';
import type { BlocklistStore } from './store.ts';

export const BLOCKLIST_REFRESH_JOB_ID = 'refresh-blocklist';

export const BLOCKLIST_REFRESH_CRON = '17 * * * *';

export const BLOCKLIST_QUEUE = 'proton-phishing-blocklist';

export interface RefreshBlocklistDeps extends BlocklistFeedOptions {
  store: BlocklistStore;
  logger: Logger;
  now?(): Date;
}

export interface RefreshOutcome {
  installed: boolean;

  size: number;
  feedsSucceeded: number;
  feedsFailed: number;

  reason?: string;
}

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
