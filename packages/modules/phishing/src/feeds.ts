import type { Logger } from '@proton/core';
import { normaliseDomain } from './domains.ts';

/**
 * Community blocklist feeds.
 *
 * This is the one Gate 2 feature with a live external dependency, so every
 * function here is written around the assumption that the network is hostile or
 * absent. Nothing in this file throws to its caller: a feed that 404s, hangs,
 * returns HTML, returns an empty body or returns 40MB of garbage produces a
 * recorded failure and the *other* feeds still contribute. A blocklist that is
 * unreachable must cost the server its phishing protection and nothing else —
 * never its message handling.
 */

/**
 * The feeds shipped by default.
 *
 * Both verified reachable on 2026-08-15 and both return a JSON array of bare
 * domain strings, which `parseFeedBody` handles natively.
 *
 *   - `Discord-AntiScam/scam-links` — a community-curated list of Discord-specific
 *     scam domains, served as a static file from GitHub raw (no rate limit worth
 *     the name, no API key, ~10k entries).
 *   - `phish.sinking.yachts` — a second, independently curated list. Included so
 *     the default is not a single point of failure: the two are unioned, so one
 *     going dark degrades coverage rather than removing it.
 *
 * **Operators may replace this list entirely** — see `BlocklistFeedOptions.feeds`.
 * It is deliberately not per-guild config: the fetched list is global and cached
 * once for every server, so a per-guild URL would mean fetching an arbitrary
 * attacker-suppliable address once per guild. That is a server-side request
 * forgery primitive handed to anyone who can open the dashboard, in exchange for
 * a setting almost no guild wants. Guilds get `blockDomains`/`allowDomains`
 * instead, which need no outbound request at all.
 */
export const DEFAULT_BLOCKLIST_FEEDS: readonly string[] = [
  'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json',
  'https://phish.sinking.yachts/v2/all',
];

/** Long enough for a slow CDN, short enough that a hung feed cannot stall a refresh. */
export const FEED_TIMEOUT_MS = 15_000;

/**
 * The largest feed body accepted, decoded.
 *
 * ~10k domains is well under 1MB, so 16MB is generous. It exists because a
 * redirected or compromised feed URL should cost a rejected refresh, not the
 * worker's heap.
 */
export const FEED_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Sent on every feed request.
 *
 * Community lists are maintained by volunteers who ask consumers to identify
 * themselves so they can tell traffic apart and reach an operator whose client
 * is misbehaving. Anonymous polling is how a free list stops being free.
 */
export const FEED_USER_AGENT = 'Proton-Bot/0.0 (+https://github.com/proton-bot; phishing-module)';

export interface FeedFailure {
  url: string;
  /** Written verbatim into the log and the `/phishing` reply — say what happened. */
  reason: string;
}

export interface FeedResult {
  url: string;
  domains: string[];
  /** Entries the feed served that were not domains, dropped by `normaliseDomain`. */
  rejected: number;
}

export interface BlocklistFetch {
  /** The union across every feed that answered, normalised and deduplicated. */
  domains: string[];
  succeeded: FeedResult[];
  failed: FeedFailure[];
}

export interface BlocklistFeedOptions {
  /** Defaults to `DEFAULT_BLOCKLIST_FEEDS`. */
  feeds?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Injected so tests never touch the network (§11: no live external calls in CI). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Parse a feed body into raw entries.
 *
 * Two shapes, because community lists use both and an operator pointing Proton
 * at their own list should not have to convert it:
 *
 *   - a JSON array of strings, which is what both defaults serve;
 *   - line-delimited text, which covers plain domain lists and hosts-file format
 *     (`0.0.0.0 evil.com`) — the last whitespace-separated token wins, so the
 *     sinkhole address in front is ignored.
 *
 * `#` and `//` start a comment. Anything that survives is still put through
 * `normaliseDomain`, so junk that parses is not junk that gets cached.
 */
export function parseFeedBody(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('the JSON body is not an array of domains');
    }
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  }

  const entries: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const withoutComment = line.split('#')[0]?.split('//')[0] ?? '';
    const tokens = withoutComment.trim().split(/\s+/).filter(Boolean);
    const last = tokens.at(-1);
    if (last !== undefined) entries.push(last);
  }
  return entries;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // An AbortSignal timeout surfaces as a bare "The operation was aborted",
    // which tells an operator nothing about which limit they hit.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `no response within ${FEED_TIMEOUT_MS}ms`;
    }
    return error.message;
  }
  return String(error);
}

async function fetchOne(url: string, options: Required<BlocklistFeedOptions>): Promise<FeedResult> {
  const response = await options.fetch(url, {
    headers: {
      accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
      'user-agent': options.userAgent,
    },
    signal: AbortSignal.timeout(options.timeoutMs),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  // Checked before the body is read where the server declares it, so an
  // oversized feed costs one header rather than a full download.
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new Error(`body is ${declared} bytes, over the ${options.maxBytes}-byte limit`);
  }

  const body = await response.text();
  if (body.length > options.maxBytes) {
    throw new Error(`body is ${body.length} bytes, over the ${options.maxBytes}-byte limit`);
  }

  const raw = parseFeedBody(body);

  const domains: string[] = [];
  const unique = new Set<string>();
  let rejected = 0;
  for (const entry of raw) {
    const domain = normaliseDomain(entry);
    if (domain === null) {
      rejected++;
      continue;
    }
    if (unique.has(domain)) continue;
    unique.add(domain);
    domains.push(domain);
  }

  // A 200 carrying no usable domain is a failure wearing a success's clothes —
  // an HTML error page, a truncated write, an API that started requiring a key.
  // Treated as a failure so it can never be mistaken for "the list is empty now".
  if (domains.length === 0) {
    throw new Error(`responded 200 but contained no usable domains (${raw.length} raw entries)`);
  }

  return { url, domains, rejected };
}

/**
 * Fetch every feed and union the results.
 *
 * Feeds are fetched concurrently and isolated from one another: one failing has
 * no effect on the rest, and the caller gets both halves of the picture so it
 * can decide what to do with a partial result. `fetchBlocklist` itself never
 * rejects.
 */
export async function fetchBlocklist(
  options: BlocklistFeedOptions & { logger: Logger },
): Promise<BlocklistFetch> {
  const resolved: Required<BlocklistFeedOptions> = {
    feeds: options.feeds ?? DEFAULT_BLOCKLIST_FEEDS,
    timeoutMs: options.timeoutMs ?? FEED_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? FEED_MAX_BYTES,
    userAgent: options.userAgent ?? FEED_USER_AGENT,
    fetch: options.fetch ?? globalThis.fetch,
  };

  const settled = await Promise.allSettled(
    resolved.feeds.map(async (url) => await fetchOne(url, resolved)),
  );

  const succeeded: FeedResult[] = [];
  const failed: FeedFailure[] = [];
  const union = new Set<string>();

  for (const [index, outcome] of settled.entries()) {
    const url = resolved.feeds[index] ?? '(unknown feed)';

    if (outcome.status === 'rejected') {
      const reason = describe(outcome.reason);
      failed.push({ url, reason });
      // Error, not warn: a feed that stops answering silently narrows what the
      // module can catch, and nothing else in the system will ever notice.
      options.logger.error(`phishing blocklist feed failed: ${url} — ${reason}`, {
        moduleId: 'phishing',
        feed: url,
      });
      continue;
    }

    succeeded.push(outcome.value);
    for (const domain of outcome.value.domains) union.add(domain);
  }

  return { domains: [...union], succeeded, failed };
}
