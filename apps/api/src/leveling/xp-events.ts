import { newId } from '@proton/core';
import { auditTrail, type DbHandle, type NewAuditTrailEntry } from '@proton/db';
import {
  createXpEvent,
  toXpEventView,
  XP_EVENT_MAX_PENDING,
  type XpEvent,
  type XpEventStore,
  type XpEventView,
  xpEventCreateSchemaAt,
} from '@proton/module-leveling';
import { z } from 'zod';

export type XpEventErrorCode = 'invalid_xp_event' | 'too_many_xp_events' | 'unknown_xp_event';

export class XpEventError extends Error {
  readonly code: XpEventErrorCode;

  constructor(code: XpEventErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'XpEventError';
  }
}

export const XP_EVENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const xpEventStartBodySchema = z.object({
  requestId: z.string().regex(XP_EVENT_REQUEST_ID),
  actorId: z.string().min(1),
  source: z.literal('dashboard').default('dashboard'),
  ipHash: z.string().min(1).max(128).optional(),
});

export type XpEventStartBody = z.infer<typeof xpEventStartBodySchema>;

export type StartXpEventInput = XpEventStartBody & { guildId: string; event: unknown };

export interface EndXpEventInput {
  guildId: string;
  eventId: string;
  actorId: string;
}

export type AuditWrite = (entry: NewAuditTrailEntry) => Promise<void>;

export function auditTrailWriter(handle: DbHandle): AuditWrite {
  return async (entry) => {
    await handle.db.insert(auditTrail).values(entry).onConflictDoNothing();
  };
}

export interface XpEventServiceOptions {
  store: XpEventStore;
  audit: AuditWrite;
  logger?: Pick<Console, 'warn'>;
  now?(): number;
}

const FIELDS: Record<string, string> = {
  multiplier: 'the multiplier',
  startsAt: 'the start',
  endsAt: 'the end',
};

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = String(issue.path[0] ?? '');
      const field = FIELDS[key] ?? (key || 'the event');
      return issue.code === 'custom' ? `${field} ${issue.message}` : `${field}: ${issue.message}`;
    })
    .join('; ');
}

function auditView(event: XpEvent) {
  return {
    id: event.id,
    multiplier: event.multiplier,
    startsAt: new Date(event.startsAt).toISOString(),
    endsAt: new Date(event.endsAt).toISOString(),
    createdBy: event.createdBy,
  };
}

export class XpEventService {
  readonly #store: XpEventStore;
  readonly #audit: AuditWrite;
  readonly #logger: Pick<Console, 'warn'>;
  readonly #now: () => number;

  constructor(options: XpEventServiceOptions) {
    this.#store = options.store;
    this.#audit = options.audit;
    this.#logger = options.logger ?? console;
    this.#now = options.now ?? Date.now;
  }

  async list(guildId: string): Promise<{ events: XpEventView[]; now: number }> {
    const now = this.#now();
    const pending = await this.#store.pending(guildId, now);

    return { events: pending.flatMap((event) => toXpEventView(event, now) ?? []), now };
  }

  async start(
    input: StartXpEventInput,
  ): Promise<{ status: 'created' | 'exists'; event: XpEventView | null }> {
    const now = this.#now();

    const parsed = xpEventCreateSchemaAt(now).safeParse(input.event);
    if (!parsed.success) {
      throw new XpEventError(
        'invalid_xp_event',
        `That XP event was not started: ${describeIssues(parsed.error)}.`,
      );
    }

    const result = await createXpEvent(
      this.#store,
      {
        guildId: input.guildId,
        id: `dashboard:${input.requestId}`,
        multiplier: Math.round(parsed.data.multiplier * 10) / 10,
        startsAt: Date.parse(parsed.data.startsAt),
        endsAt: Date.parse(parsed.data.endsAt),
        createdBy: input.actorId,
        now,
        maxPending: XP_EVENT_MAX_PENDING,
      },
      (error) =>
        this.#logger.warn(
          `an XP event was started in ${input.guildId} but events that ended over a week ago ` +
            `could not be cleared out: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );

    if (result.status === 'full') {
      throw new XpEventError(
        'too_many_xp_events',
        `This server already has ${result.pending} XP events active or scheduled, and ` +
          `${XP_EVENT_MAX_PENDING} is the most it can have. End or cancel one, or wait for one ` +
          'to finish. Nothing was started.',
      );
    }

    // Keyed on the event, not newId(): a replayed start writes a missing audit row once, never twice.
    await this.#audit({
      id: `xp_event.create:${input.guildId}:${result.event.id}`,
      guildId: input.guildId,
      actorId: input.actorId,
      source: input.source,
      action: 'module.leveling.xp_event.create',
      before: null,
      after: auditView(result.event),
      ipHash: input.ipHash ?? null,
    });

    return { status: result.status, event: toXpEventView(result.event, now) };
  }

  async end(input: EndXpEventInput): Promise<{ result: 'ended' | 'cancelled' }> {
    const now = this.#now();

    const pending = await this.#store.pending(input.guildId, now);
    const held = pending.find((event) => event.id === input.eventId);

    const result = await this.#store.end(input.guildId, input.eventId, now, (change) => ({
      id: newId(),
      guildId: input.guildId,
      actorId: input.actorId,
      source: 'dashboard',
      action:
        change === 'ended' ? 'module.leveling.xp_event.end' : 'module.leveling.xp_event.cancel',
      before: held ? auditView(held) : null,
      after: change === 'ended' ? { id: input.eventId, endsAt: new Date(now).toISOString() } : null,
      ipHash: null,
    }));

    if (result === 'not_found') {
      throw new XpEventError(
        'unknown_xp_event',
        'That XP event has already ended or been cancelled, so there was nothing to end. Reload ' +
          'the page to see where things stand.',
      );
    }

    return { result };
  }
}
