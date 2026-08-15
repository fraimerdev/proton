import type { PhishingConfig } from './config.ts';
import { firstMatch, messageCandidates, toDomainSet } from './domains.ts';

/**
 * Deciding whether a message carries a phishing link.
 *
 * Separated from the listener so the decision can be tested against a plain
 * object and a stub lookup — no bus, no executor, no Redis. Everything that
 * follows a match (who gets timed out, where the alert goes) is the listener's.
 */

/** The fields of a Discord message this module reads, and no others. */
export interface InspectedMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
}

/**
 * Pull the message out of a raw dispatch payload.
 *
 * The gateway hands listeners the raw Discord object for message events, so this
 * is the one place in the module that knows Discord's shape. Returns null rather
 * than throwing for anything unreadable: MESSAGE_UPDATE is a *partial* — an
 * embed resolving server-side produces one with no `content` at all — and a
 * module that threw on those would have the bus redeliver them forever.
 */
export function readMessage(payload: unknown): InspectedMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  const messageId = typeof raw.id === 'string' ? raw.id : null;
  const channelId = typeof raw.channel_id === 'string' ? raw.channel_id : null;
  const content = typeof raw.content === 'string' ? raw.content : null;

  const author = typeof raw.author === 'object' && raw.author !== null ? raw.author : {};
  const authorId = (author as Record<string, unknown>).id;

  if (messageId === null || channelId === null || content === null) return null;
  if (typeof authorId !== 'string') return null;

  return { messageId, channelId, authorId, content };
}

/** Where the matching entry came from, so the alert can say. */
export type MatchSource = 'community-list' | 'server-list';

export type PhishingVerdict =
  | { matched: false }
  | {
      matched: true;
      /** The host as it appeared in the message — what a moderator will search for. */
      host: string;
      /** The listed entry that matched it, which may be a parent domain. */
      domain: string;
      source: MatchSource;
    };

export type BlocklistLookup = (candidates: readonly string[]) => Promise<string | null>;

/**
 * Check one message.
 *
 * Order is deliberate and is the cheap-to-expensive order as well as the correct
 * one: the server's allowlist wins over everything, then the server's own
 * blocklist (in memory, no round trip), then the community list (one Redis
 * command for every candidate the message produced).
 *
 * The allowlist is applied per host rather than to the whole message. A message
 * linking both an allowed domain and a blocked one is still a phishing message;
 * letting one allowed link immunise the rest would make `allowDomains` a way to
 * disable the module by posting a permitted URL alongside the scam.
 */
export async function inspectMessage(
  message: InspectedMessage,
  config: PhishingConfig,
  lookup: BlocklistLookup,
): Promise<PhishingVerdict> {
  const entries = messageCandidates(message.content);
  if (entries.length === 0) return { matched: false };

  const allowed = toDomainSet(config.allowDomains);
  const blocked = toDomainSet(config.blockDomains);

  // Candidates are collected across every host so the community list is asked
  // once per message rather than once per host, and mapped back afterwards so
  // the alert can name the host the reader will actually see in the channel.
  const ordered: string[] = [];
  const owner = new Map<string, string>();

  for (const entry of entries) {
    if (firstMatch(entry, allowed) !== null) continue;

    const local = firstMatch(entry, blocked);
    if (local !== null) {
      return { matched: true, host: entry.host, domain: local, source: 'server-list' };
    }

    for (const candidate of entry.candidates) {
      if (owner.has(candidate)) continue;
      owner.set(candidate, entry.host);
      ordered.push(candidate);
    }
  }

  if (ordered.length === 0) return { matched: false };

  const hit = await lookup(ordered);
  if (hit === null) return { matched: false };

  return {
    matched: true,
    host: owner.get(hit) ?? hit,
    domain: hit,
    source: 'community-list',
  };
}
