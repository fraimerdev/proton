import type { NewAuditTrailEntry } from '@proton/db';
import { XP_EVENT_RETENTION_MS, type XpEventStatus, type XpEventView } from './config.ts';

export interface XpEvent {
  guildId: string;
  id: string;
  multiplier: number;
  startsAt: number;
  endsAt: number;
  createdBy: string;
  createdAt: number;
}

export interface CreateXpEventInput {
  guildId: string;
  id: string;
  multiplier: number;
  startsAt: number;
  endsAt: number;
  createdBy: string;
  now: number;
  maxPending: number;
}

export type CreateXpEventResult =
  | { status: 'created'; event: XpEvent }
  | { status: 'exists'; event: XpEvent }
  | { status: 'full'; pending: number };

export type EndXpEventResult = 'ended' | 'cancelled' | 'not_found';

export type EndXpEventAudit = (result: 'ended' | 'cancelled') => NewAuditTrailEntry;

export interface XpEventStore {
  overlapping(guildId: string, from: number, to: number): Promise<XpEvent[]>;

  pending(guildId: string, now: number): Promise<XpEvent[]>;

  create(input: CreateXpEventInput): Promise<CreateXpEventResult>;

  end(guildId: string, id: string, now: number, audit?: EndXpEventAudit): Promise<EndXpEventResult>;

  purgeEndedBefore(guildId: string, before: number): Promise<number>;
}

export function xpEventStatus(
  event: Pick<XpEvent, 'startsAt' | 'endsAt'>,
  now: number,
): XpEventStatus | null {
  if (event.endsAt <= now) return null;
  return event.startsAt <= now ? 'active' : 'scheduled';
}

export function toXpEventView(event: XpEvent, now: number): XpEventView | null {
  const status = xpEventStatus(event, now);
  if (status === null) return null;

  return {
    id: event.id,
    multiplier: event.multiplier,
    startsAt: new Date(event.startsAt).toISOString(),
    endsAt: new Date(event.endsAt).toISOString(),
    createdBy: event.createdBy,
    createdAt: new Date(event.createdAt).toISOString(),
    status,
  };
}

export async function createXpEvent(
  store: XpEventStore,
  input: CreateXpEventInput,
  onPurgeFailed?: (error: unknown) => void,
): Promise<CreateXpEventResult> {
  const result = await store.create(input);
  if (result.status !== 'created') return result;

  try {
    await store.purgeEndedBefore(input.guildId, input.now - XP_EVENT_RETENTION_MS);
  } catch (error) {
    if (!onPurgeFailed) throw error;
    onPurgeFailed(error);
  }

  return result;
}
