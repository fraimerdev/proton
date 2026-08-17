import { firstMatch, messageCandidates, toDomainSet } from '@proton/core';
import type { PhishingConfig } from './config.ts';

export interface InspectedMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
}

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

export type MatchSource = 'community-list' | 'server-list';

export type PhishingVerdict =
  | { matched: false }
  | {
      matched: true;

      host: string;

      domain: string;
      source: MatchSource;
    };

export type BlocklistLookup = (candidates: readonly string[]) => Promise<string | null>;

export async function inspectMessage(
  message: InspectedMessage,
  config: PhishingConfig,
  lookup: BlocklistLookup,
): Promise<PhishingVerdict> {
  const entries = messageCandidates(message.content);
  if (entries.length === 0) return { matched: false };

  const allowed = toDomainSet(config.allowDomains);
  const blocked = toDomainSet(config.blockDomains);

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
