import { XP_EVENT_MAX_DURATION_MS, XP_EVENT_MAX_LEAD_MS } from './config.ts';
import { MAX_PAID_SESSION_MS } from './voice-session.ts';
import type {
  CreateXpEventInput,
  CreateXpEventResult,
  EndXpEventAudit,
  EndXpEventResult,
  XpEvent,
  XpEventStore,
} from './xp-events.ts';

export const XP_EVENT_CACHE_TTL_MS = 30_000;

const LOOKBACK_MS = MAX_PAID_SESSION_MS + 60 * 60_000;

const LOOKAHEAD_MS = XP_EVENT_MAX_LEAD_MS + XP_EVENT_MAX_DURATION_MS;

const SWEEP_AT = 1024;

export interface CachedXpEventStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

interface Entry {
  from: number;
  to: number;
  expiresAt: number;
  events: Promise<XpEvent[]>;
}

export class CachedXpEventStore implements XpEventStore {
  readonly #store: XpEventStore;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(store: XpEventStore, options: CachedXpEventStoreOptions = {}) {
    this.#store = store;
    this.#ttlMs = options.ttlMs ?? XP_EVENT_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  async overlapping(guildId: string, from: number, to: number): Promise<XpEvent[]> {
    const now = this.#now();
    const cached = this.#entries.get(guildId);
    const entry = cached && cached.expiresAt > now ? cached : this.#fetch(guildId, now);

    if (from < entry.from || to > entry.to) return this.#store.overlapping(guildId, from, to);

    const events = await entry.events;
    return events.filter((event) => event.startsAt < to && event.endsAt > from);
  }

  pending(guildId: string, now: number): Promise<XpEvent[]> {
    return this.#store.pending(guildId, now);
  }

  async create(input: CreateXpEventInput): Promise<CreateXpEventResult> {
    const result = await this.#store.create(input);
    this.#entries.delete(input.guildId);
    return result;
  }

  async end(
    guildId: string,
    id: string,
    now: number,
    audit?: EndXpEventAudit,
  ): Promise<EndXpEventResult> {
    const result = await this.#store.end(guildId, id, now, audit);
    this.#entries.delete(guildId);
    return result;
  }

  async purgeEndedBefore(guildId: string, before: number): Promise<number> {
    const removed = await this.#store.purgeEndedBefore(guildId, before);
    this.#entries.delete(guildId);
    return removed;
  }

  #fetch(guildId: string, now: number): Entry {
    const from = now - LOOKBACK_MS;
    const to = now + LOOKAHEAD_MS;

    const entry: Entry = {
      from,
      to,
      expiresAt: now + this.#ttlMs,
      events: this.#store.overlapping(guildId, from, to),
    };

    entry.events.catch(() => {
      if (this.#entries.get(guildId) === entry) this.#entries.delete(guildId);
    });

    if (this.#entries.size >= SWEEP_AT) {
      for (const [key, stale] of this.#entries) {
        if (stale.expiresAt <= now) this.#entries.delete(key);
      }
    }

    this.#entries.set(guildId, entry);
    return entry;
  }
}
