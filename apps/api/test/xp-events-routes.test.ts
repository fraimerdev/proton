import { describe, expect, test } from 'bun:test';
import type { NewAuditTrailEntry } from '@proton/db';
import type {
  CreateXpEventInput,
  CreateXpEventResult,
  EndXpEventAudit,
  EndXpEventResult,
  XpEvent,
  XpEventStore,
} from '@proton/module-leveling';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { type AuditWrite, XpEventService } from '../src/leveling/xp-events.ts';

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const ADMIN = '100000000000000001';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-13T12:00:00.000Z');

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const GONE = {
  presence: () => Promise.resolve({ present: [], known: true }),
};

class MemoryXpEventStore implements XpEventStore {
  readonly rows = new Map<string, XpEvent>();
  readonly purges: Array<{ guildId: string; before: number }> = [];
  readonly #audit: AuditWrite;

  constructor(audit: AuditWrite) {
    this.#audit = audit;
  }

  seed(...events: XpEvent[]): this {
    for (const event of events) this.rows.set(`${event.guildId}:${event.id}`, event);
    return this;
  }

  #of(guildId: string): XpEvent[] {
    return [...this.rows.values()]
      .filter((event) => event.guildId === guildId)
      .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  }

  async overlapping(guildId: string, from: number, to: number): Promise<XpEvent[]> {
    return this.#of(guildId).filter((event) => event.startsAt < to && event.endsAt > from);
  }

  async pending(guildId: string, now: number): Promise<XpEvent[]> {
    return this.#of(guildId).filter((event) => event.endsAt > now);
  }

  async create(input: CreateXpEventInput): Promise<CreateXpEventResult> {
    const existing = this.rows.get(`${input.guildId}:${input.id}`);
    if (existing) return { status: 'exists', event: existing };

    const pending = (await this.pending(input.guildId, input.now)).length;
    if (pending >= input.maxPending) return { status: 'full', pending };

    const event: XpEvent = {
      guildId: input.guildId,
      id: input.id,
      multiplier: input.multiplier,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: input.createdBy,
      createdAt: input.now,
    };

    this.rows.set(`${input.guildId}:${input.id}`, event);
    return { status: 'created', event };
  }

  async end(
    guildId: string,
    id: string,
    now: number,
    audit?: EndXpEventAudit,
  ): Promise<EndXpEventResult> {
    const key = `${guildId}:${id}`;
    const event = this.rows.get(key);
    if (!event || event.endsAt <= now) return 'not_found';

    const result = event.startsAt <= now ? 'ended' : 'cancelled';
    if (audit) await this.#audit(audit(result));

    if (result === 'ended') this.rows.set(key, { ...event, endsAt: now });
    else this.rows.delete(key);

    return result;
  }

  async purgeEndedBefore(guildId: string, before: number): Promise<number> {
    this.purges.push({ guildId, before });

    let removed = 0;
    for (const [key, event] of this.rows) {
      if (event.guildId === guildId && event.endsAt < before) {
        this.rows.delete(key);
        removed++;
      }
    }

    return removed;
  }
}

function xpEvent(overrides: Partial<XpEvent> & Pick<XpEvent, 'id'>): XpEvent {
  return {
    guildId: GUILD,
    multiplier: 2,
    startsAt: NOW - HOUR,
    endsAt: NOW + HOUR,
    createdBy: ADMIN,
    createdAt: NOW - 2 * HOUR,
    ...overrides,
  };
}

function harness(options: { guilds?: unknown; seed?: XpEvent[]; failedAudits?: number } = {}) {
  const audits: NewAuditTrailEntry[] = [];
  let failures = options.failedAudits ?? 0;

  const audit: AuditWrite = async (entry) => {
    if (failures > 0) {
      failures--;
      throw new Error('connection terminated unexpectedly');
    }
    if (!audits.some((held) => held.id === entry.id)) audits.push(entry);
  };

  const store = new MemoryXpEventStore(audit).seed(...(options.seed ?? []));

  const service = new XpEventService({
    store,
    audit,
    now: () => NOW,
    logger: { warn: () => {} },
  });

  const app = createApiApp({
    xpEvents: service,
    guilds: options.guilds ?? HERE,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  return { app, store, audits };
}

const NO_SECRET = Symbol('no secret');

function send(
  app: ReturnType<typeof createApiApp>,
  method: string,
  path: string,
  options: { body?: unknown; secret?: string | typeof NO_SECRET; actor?: string | null } = {},
) {
  const secret = options.secret ?? SECRET;

  return app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
      ...(options.actor === null ? {} : { 'x-proton-actor': options.actor ?? ADMIN }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const iso = (at: number) => new Date(at).toISOString();

const EVENTS = `/guilds/${GUILD}/leveling/xp-events`;

const START = {
  requestId: 'req-0000000001',
  actorId: ADMIN,
  source: 'dashboard',
  ipHash: 'hash123',
  multiplier: 2,
  startsAt: iso(NOW),
  endsAt: iso(NOW + 2 * HOUR),
};

interface Refusal {
  error: string;
  message: string;
}

describe('GET /guilds/:guildId/leveling/xp-events', () => {
  test('is refused without the shared secret', async () => {
    const { app } = harness();

    expect((await send(app, 'GET', EVENTS, { secret: NO_SECRET })).status).toBe(401);
  });

  test('lists active and scheduled events soonest first, and leaves ended ones out', async () => {
    const { app } = harness({
      seed: [
        xpEvent({ id: 'scheduled', startsAt: NOW + DAY, endsAt: NOW + DAY + HOUR }),
        xpEvent({ id: 'ended', startsAt: NOW - 3 * HOUR, endsAt: NOW - MINUTE }),
        xpEvent({ id: 'active', multiplier: 1.5 }),
        xpEvent({ id: 'elsewhere', guildId: OTHER }),
      ],
    });

    const response = await send(app, 'GET', EVENTS);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { events: Array<Record<string, unknown>>; now: number };

    expect(body.now).toBe(NOW);
    expect(body.events.map((event) => [event.id, event.status])).toEqual([
      ['active', 'active'],
      ['scheduled', 'scheduled'],
    ]);
    expect(body.events[0]).toEqual({
      id: 'active',
      multiplier: 1.5,
      startsAt: iso(NOW - HOUR),
      endsAt: iso(NOW + HOUR),
      createdBy: ADMIN,
      createdAt: iso(NOW - 2 * HOUR),
      status: 'active',
    });
  });

  test('answers an empty list for a server with no events', async () => {
    const { app } = harness();

    expect(await (await send(app, 'GET', EVENTS)).json()).toEqual({ events: [], now: NOW });
  });

  test('is not behind the write-presence guard, so a server Proton left can still be read', async () => {
    const { app } = harness({ guilds: GONE, seed: [xpEvent({ id: 'active' })] });

    expect((await send(app, 'GET', EVENTS)).status).toBe(200);
  });
});

describe('POST /guilds/:guildId/leveling/xp-events', () => {
  test('is refused without the shared secret', async () => {
    const { app, store } = harness();

    expect((await send(app, 'POST', EVENTS, { body: START, secret: NO_SECRET })).status).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  test('starts an event under an id taken from the request, created by the actor', async () => {
    const { app, store } = harness();

    const response = await send(app, 'POST', EVENTS, { body: START });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'created',
      event: {
        id: 'dashboard:req-0000000001',
        multiplier: 2,
        startsAt: iso(NOW),
        endsAt: iso(NOW + 2 * HOUR),
        createdBy: ADMIN,
        createdAt: iso(NOW),
        status: 'active',
      },
    });
    expect(store.rows.get(`${GUILD}:dashboard:req-0000000001`)).toMatchObject({
      guildId: GUILD,
      multiplier: 2,
      startsAt: NOW,
      endsAt: NOW + 2 * HOUR,
    });
  });

  test('schedules an event that starts later', async () => {
    const { app } = harness();

    const body = (await (
      await send(app, 'POST', EVENTS, {
        body: { ...START, startsAt: iso(NOW + DAY), endsAt: iso(NOW + DAY + HOUR) },
      })
    ).json()) as { event: { status: string } };

    expect(body.event.status).toBe('scheduled');
  });

  test('writes an audit row naming the actor, the event and the ip hash', async () => {
    const { app, audits } = harness();

    await send(app, 'POST', EVENTS, { body: START });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      guildId: GUILD,
      actorId: ADMIN,
      source: 'dashboard',
      action: 'module.leveling.xp_event.create',
      before: null,
      after: {
        id: 'dashboard:req-0000000001',
        multiplier: 2,
        startsAt: iso(NOW),
        endsAt: iso(NOW + 2 * HOUR),
        createdBy: ADMIN,
      },
      ipHash: 'hash123',
    });
  });

  test('clears out events that ended more than a week ago when one is created', async () => {
    const { app, store } = harness({
      seed: [xpEvent({ id: 'old', startsAt: NOW - 9 * DAY, endsAt: NOW - 8 * DAY })],
    });

    await send(app, 'POST', EVENTS, { body: START });

    expect(store.purges).toEqual([{ guildId: GUILD, before: NOW - 7 * DAY }]);
    expect(store.rows.has(`${GUILD}:old`)).toBe(false);
  });

  test('a replayed request returns the stored event instead of starting a second', async () => {
    const { app, store, audits } = harness();

    await send(app, 'POST', EVENTS, { body: START });
    const replay = await send(app, 'POST', EVENTS, { body: { ...START, multiplier: 3 } });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: 'exists',
      event: { id: 'dashboard:req-0000000001', multiplier: 2 },
    });
    expect(store.rows.size).toBe(1);
    expect(audits).toHaveLength(1);
  });

  test('rounds the multiplier to its tenth, as the command does', async () => {
    const { app, store } = harness();

    await send(app, 'POST', EVENTS, { body: { ...START, multiplier: 0.30000000000000004 } });

    expect(store.rows.get(`${GUILD}:dashboard:req-0000000001`)?.multiplier).toBe(0.3);
  });

  test('accepts a start a few minutes behind the server clock', async () => {
    const { app } = harness();

    const response = await send(app, 'POST', EVENTS, {
      body: { ...START, startsAt: iso(NOW - 2 * MINUTE), endsAt: iso(NOW + HOUR) },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'created', event: { status: 'active' } });
  });

  test('refuses a start in the past, naming the field and saying nothing was started', async () => {
    const { app, store, audits } = harness();

    const response = await send(app, 'POST', EVENTS, {
      body: { ...START, startsAt: iso(NOW - HOUR), endsAt: iso(NOW + HOUR) },
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as Refusal;
    expect(body.error).toBe('invalid_xp_event');
    expect(body.message).toStartWith('That XP event was not started: the start is in the past');
    expect(store.rows.size).toBe(0);
    expect(audits).toHaveLength(0);
  });

  test('refuses a start more than 30 days away', async () => {
    const { app } = harness();

    const response = await send(app, 'POST', EVENTS, {
      body: { ...START, startsAt: iso(NOW + 31 * DAY), endsAt: iso(NOW + 31 * DAY + HOUR) },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as Refusal).message).toContain('more than 30 days away');
  });

  test('refuses an event shorter than 10 minutes or longer than 14 days', async () => {
    const { app, store } = harness();

    const short = await send(app, 'POST', EVENTS, {
      body: { ...START, endsAt: iso(NOW + 9 * MINUTE) },
    });
    const long = await send(app, 'POST', EVENTS, {
      body: { ...START, endsAt: iso(NOW + 15 * DAY) },
    });

    expect([short.status, long.status]).toEqual([400, 400]);
    expect(((await short.json()) as Refusal).message).toContain(
      'the end must be at least 10 minutes after the start',
    );
    expect(((await long.json()) as Refusal).message).toContain(
      'the end must be at most 14 days after the start',
    );
    expect(store.rows.size).toBe(0);
  });

  test('refuses a multiplier outside 0.1 to 5 or off the 0.1 step', async () => {
    const { app, store } = harness();

    for (const multiplier of [0, 5.5, 1.25, '2']) {
      const response = await send(app, 'POST', EVENTS, { body: { ...START, multiplier } });

      expect(response.status).toBe(400);

      const body = (await response.json()) as Refusal;
      expect(body.error).toBe('invalid_xp_event');
      expect(body.message).toStartWith('That XP event was not started: the multiplier');
    }

    expect(store.rows.size).toBe(0);
  });

  test('refuses a date that is not a timestamp with an offset', async () => {
    const { app } = harness();

    const response = await send(app, 'POST', EVENTS, { body: { ...START, startsAt: 'tomorrow' } });

    expect(response.status).toBe(400);
    expect(((await response.json()) as Refusal).message).toContain('the start:');
  });

  test('refuses a sixth pending event with a reason naming the limit', async () => {
    const { app, store, audits } = harness({
      seed: [0, 1, 2, 3, 4].map((n) =>
        xpEvent({ id: `pending-${n}`, startsAt: NOW + n * DAY, endsAt: NOW + n * DAY + HOUR }),
      ),
    });

    const response = await send(app, 'POST', EVENTS, { body: START });

    expect(response.status).toBe(409);

    const body = (await response.json()) as Refusal;
    expect(body.error).toBe('too_many_xp_events');
    expect(body.message).toContain('already has 5 XP events active or scheduled');
    expect(body.message).toContain('Nothing was started');
    expect(store.rows.size).toBe(5);
    expect(audits).toHaveLength(0);
  });

  test('ended events do not count toward the limit', async () => {
    const { app } = harness({
      seed: [0, 1, 2, 3, 4].map((n) =>
        xpEvent({ id: `ended-${n}`, startsAt: NOW - DAY, endsAt: NOW - HOUR }),
      ),
    });

    expect((await send(app, 'POST', EVENTS, { body: START })).status).toBe(200);
  });

  test('refuses a body without an actor or a request id', async () => {
    const { app, store } = harness();
    const { actorId: _actor, ...noActor } = START;
    const { requestId: _request, ...noRequest } = START;

    const responses = await Promise.all([
      send(app, 'POST', EVENTS, { body: noActor }),
      send(app, 'POST', EVENTS, { body: noRequest }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400]);
    expect(await responses[0]?.json()).toMatchObject({ error: 'invalid_body' });
    expect(store.rows.size).toBe(0);
  });

  test('refuses a request id shaped like a command-created event id', async () => {
    const { app, store } = harness();

    const response = await send(app, 'POST', EVENTS, {
      body: { ...START, requestId: 'command:123456789012345678' },
    });

    expect(response.status).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  test('is scoped to the guild in the path', async () => {
    const { app, store } = harness();

    await send(app, 'POST', `/guilds/${OTHER}/leveling/xp-events`, { body: START });

    expect([...store.rows.values()].map((event) => event.guildId)).toEqual([OTHER]);
  });

  test('is caught by the write-presence guard for a server Proton has left', async () => {
    const { app, store } = harness({ guilds: GONE });

    const response = await send(app, 'POST', EVENTS, { body: START });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'bot_absent' });
    expect(store.rows.size).toBe(0);
  });
});

describe('DELETE /guilds/:guildId/leveling/xp-events/:eventId', () => {
  test('is refused without the shared secret', async () => {
    const { app, store } = harness({ seed: [xpEvent({ id: 'active' })] });

    expect((await send(app, 'DELETE', `${EVENTS}/active`, { secret: NO_SECRET })).status).toBe(401);
    expect(store.rows.get(`${GUILD}:active`)?.endsAt).toBe(NOW + HOUR);
  });

  test('is refused when no actor is named', async () => {
    const { app, store } = harness({ seed: [xpEvent({ id: 'active' })] });

    const response = await send(app, 'DELETE', `${EVENTS}/active`, { actor: null });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(store.rows.get(`${GUILD}:active`)?.endsAt).toBe(NOW + HOUR);
  });

  test('ends an active event at the moment it was asked', async () => {
    const { app, store } = harness({ seed: [xpEvent({ id: 'active' })] });

    const response = await send(app, 'DELETE', `${EVENTS}/active`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'ended' });
    expect(store.rows.get(`${GUILD}:active`)?.endsAt).toBe(NOW);
    expect(await (await send(app, 'GET', EVENTS)).json()).toEqual({ events: [], now: NOW });
  });

  test('cancels a scheduled event outright', async () => {
    const { app, store } = harness({
      seed: [xpEvent({ id: 'scheduled', startsAt: NOW + DAY, endsAt: NOW + DAY + HOUR })],
    });

    const response = await send(app, 'DELETE', `${EVENTS}/scheduled`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'cancelled' });
    expect(store.rows.has(`${GUILD}:scheduled`)).toBe(false);
  });

  test('audits an end and a cancel with what the event was', async () => {
    const { app, audits } = harness({
      seed: [
        xpEvent({ id: 'active' }),
        xpEvent({ id: 'scheduled', startsAt: NOW + DAY, endsAt: NOW + DAY + HOUR }),
      ],
    });

    await send(app, 'DELETE', `${EVENTS}/active`);
    await send(app, 'DELETE', `${EVENTS}/scheduled`);

    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      guildId: GUILD,
      actorId: ADMIN,
      source: 'dashboard',
      action: 'module.leveling.xp_event.end',
      before: { id: 'active', multiplier: 2, endsAt: iso(NOW + HOUR) },
      after: { id: 'active', endsAt: iso(NOW) },
    });
    expect(audits[1]).toMatchObject({
      action: 'module.leveling.xp_event.cancel',
      before: { id: 'scheduled', startsAt: iso(NOW + DAY) },
      after: null,
    });
    expect(audits[0]?.id).not.toBe(audits[1]?.id);
  });

  test('an end whose audit row cannot be written is not applied, so a retry ends it and audits it once', async () => {
    const { app, store, audits } = harness({ seed: [xpEvent({ id: 'active' })], failedAudits: 1 });

    const failed = await send(app, 'DELETE', `${EVENTS}/active`);

    expect(failed.status).toBe(500);
    expect(store.rows.get(`${GUILD}:active`)?.endsAt).toBe(NOW + HOUR);
    expect(audits).toHaveLength(0);

    const retried = await send(app, 'DELETE', `${EVENTS}/active`);

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ result: 'ended' });
    expect(store.rows.get(`${GUILD}:active`)?.endsAt).toBe(NOW);
    expect(audits.map((entry) => entry.action)).toEqual(['module.leveling.xp_event.end']);
  });

  test('a cancel whose audit row cannot be written keeps the event, so a retry cancels it and audits it once', async () => {
    const { app, store, audits } = harness({
      seed: [xpEvent({ id: 'scheduled', startsAt: NOW + DAY, endsAt: NOW + DAY + HOUR })],
      failedAudits: 1,
    });

    expect((await send(app, 'DELETE', `${EVENTS}/scheduled`)).status).toBe(500);
    expect(store.rows.has(`${GUILD}:scheduled`)).toBe(true);

    const retried = await send(app, 'DELETE', `${EVENTS}/scheduled`);

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ result: 'cancelled' });
    expect(store.rows.has(`${GUILD}:scheduled`)).toBe(false);
    expect(audits.map((entry) => entry.action)).toEqual(['module.leveling.xp_event.cancel']);
  });

  test('answers 404 for an event that has already ended or never existed', async () => {
    const { app, audits } = harness({
      seed: [xpEvent({ id: 'ended', startsAt: NOW - 3 * HOUR, endsAt: NOW - MINUTE })],
    });

    const ended = await send(app, 'DELETE', `${EVENTS}/ended`);
    const missing = await send(app, 'DELETE', `${EVENTS}/missing`);

    expect([ended.status, missing.status]).toEqual([404, 404]);

    const body = (await ended.json()) as Refusal;
    expect(body.error).toBe('unknown_xp_event');
    expect(body.message).toContain('nothing to end');
    expect(audits).toHaveLength(0);
  });

  test('reads an id the /xp event command created, colon and all', async () => {
    const id = 'command:123456789012345678';
    const { app, store } = harness({ seed: [xpEvent({ id })] });

    const response = await send(app, 'DELETE', `${EVENTS}/${encodeURIComponent(id)}`);

    expect(response.status).toBe(200);
    expect(store.rows.get(`${GUILD}:${id}`)?.endsAt).toBe(NOW);
  });

  test("cannot end another server's event", async () => {
    const { app, store } = harness({ seed: [xpEvent({ id: 'active', guildId: OTHER })] });

    expect((await send(app, 'DELETE', `${EVENTS}/active`)).status).toBe(404);
    expect(store.rows.get(`${OTHER}:active`)?.endsAt).toBe(NOW + HOUR);
  });

  test('is caught by the write-presence guard for a server Proton has left', async () => {
    const { app, store } = harness({ guilds: GONE, seed: [xpEvent({ id: 'active' })] });

    expect((await send(app, 'DELETE', `${EVENTS}/active`)).status).toBe(409);
    expect(store.rows.get(`${GUILD}:active`)?.endsAt).toBe(NOW + HOUR);
  });
});
