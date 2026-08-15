import type { Logger } from '@proton/core';
import { normaliseDomain } from './domains.ts';

export const DEFAULT_BLOCKLIST_FEEDS: readonly string[] = [
  'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json',
  'https://phish.sinking.yachts/v2/all',
];

export const FEED_TIMEOUT_MS = 15_000;

export const FEED_MAX_BYTES = 16 * 1024 * 1024;

export const FEED_USER_AGENT = 'Proton-Bot/0.0 (+https://github.com/proton-bot; phishing-module)';

export interface FeedFailure {
  url: string;

  reason: string;
}

export interface FeedResult {
  url: string;
  domains: string[];

  rejected: number;
}

export interface BlocklistFetch {
  domains: string[];
  succeeded: FeedResult[];
  failed: FeedFailure[];
}

export interface BlocklistFeedOptions {
  feeds?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;

  fetch?: typeof globalThis.fetch;
}

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

  if (domains.length === 0) {
    throw new Error(`responded 200 but contained no usable domains (${raw.length} raw entries)`);
  }

  return { url, domains, rejected };
}

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
