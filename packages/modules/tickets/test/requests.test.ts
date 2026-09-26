import { describe, expect, test } from 'bun:test';
import {
  encodeCustomId,
  type GuildStateStore,
  newId,
  type ProtonEvent,
  type RestRequestOptions,
  type TicketOpenAnswered,
  ticketClosedEventSchema,
  ticketOpenedEventSchema,
} from '@proton/core';
import { ticketTypeSchema } from '../src/config.ts';
import type { TicketsDeps } from '../src/deps.ts';
import { closeTicket, reopenTicket } from '../src/lifecycle.ts';
import { OVERWRITE_MEMBER, TICKET_MEMBER_ALLOW } from '../src/overwrites.ts';
import { patrol } from '../src/reconcile.ts';
import { TICKETS_OFF_REASON, TICKETS_UNAVAILABLE_REASON } from '../src/requests.ts';
import {
  CATEGORY,
  CREATED,
  GUILD,
  HELPER,
  harness,
  MEMBER,
  OTHER_HELPER,
  PANEL,
  pressEvent,
  TYPE,
} from './harness.ts';

const APPLICANT = MEMBER;
const REVIEWER = HELPER;
const SECOND = '500000000000000011';

type Harness = ReturnType<typeof harness>;

function requestEvent(overrides: Record<string, unknown> = {}): ProtonEvent {
  const payload = {
    guildId: GUILD,
    requestId: 'effect-1',
    sourceModule: 'applications',
    sourceRef: 'app-1',
    typeId: TYPE.id,
    ownerId: APPLICANT,
    requestedById: REVIEWER,
    subject: 'Moderator Application #12',
    context: [
      { label: 'Form', value: 'Moderator Application' },
      { label: 'Reference', value: '#12' },
    ],
    participantIds: [REVIEWER],
    ...overrides,
  };

  return {
    id: `tickets.open_requested:${GUILD}:${String(payload.requestId)}`,
    type: 'tickets.open_requested',
    guildId: GUILD,
    occurredAt: Date.UTC(2026, 7, 24, 12, 0, 0),
    payload,
  };
}

function answers(h: Harness): TicketOpenAnswered[] {
  return h.published
    .filter((entry) => entry.type === 'tickets.open_answered')
    .map((entry) => entry.payload as TicketOpenAnswered);
}

function creates(h: Harness): RestRequestOptions[] {
  return h.rest.calls.filter(
    (call) => call.method === 'POST' && call.path === `/guilds/${GUILD}/channels`,
  );
}

function firstCreate(h: Harness): { name?: string; permission_overwrites?: Array<{ id: string }> } {
  return (creates(h)[0]?.body ?? {}) as {
    name?: string;
    permission_overwrites?: Array<{ id: string }>;
  };
}

function withChannel(h: Harness, channel: { id: string; name: string }): TicketsDeps {
  const inner = h.deps.guildState;

  const guildState: GuildStateStore = {
    get: async (guildId) => {
      const state = (await inner?.get(guildId)) ?? null;

      state?.channels.set(channel.id, {
        id: channel.id,
        type: 0,
        name: channel.name,
        parentId: CATEGORY,
        overwrites: [
          { id: APPLICANT, type: OVERWRITE_MEMBER, allow: TICKET_MEMBER_ALLOW, deny: 0n },
        ],
      });

      return state;
    },
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  return { ...h.deps, guildState };
}

function unreachableCreates(h: Harness): { restore(): void } {
  const request = h.rest.request.bind(h.rest);
  let down = true;

  h.rest.request = async (options) => {
    if (down && options.method === 'POST' && options.path === `/guilds/${GUILD}/channels`) {
      h.rest.calls.push(options);
      throw new Error('socket hang up');
    }

    return request(options);
  };

  return {
    restore() {
      down = false;
    },
  };
}

describe('another module asking for a ticket', () => {
  test('opens a private ticket owned by the member, raised by the reviewer, linked to its source', async () => {
    const h = harness();
    await h.press(requestEvent());

    const ticket = h.ticket();
    expect(ticket.ownerId).toBe(APPLICANT);
    expect(ticket.openerId).toBe(REVIEWER);
    expect(ticket.channelId).toBe(CREATED);
    expect(ticket.subject).toBe('Moderator Application #12');
    expect(ticket.source).toEqual({ module: 'applications', ref: 'app-1' });

    const overwrites = firstCreate(h).permission_overwrites;
    expect(overwrites?.some((entry) => entry.id === APPLICANT)).toBe(true);
    expect(overwrites?.some((entry) => entry.id === REVIEWER)).toBe(true);

    expect(answers(h)).toEqual([
      {
        guildId: GUILD,
        requestId: 'effect-1',
        sourceModule: 'applications',
        sourceRef: 'app-1',
        status: 'opened',
        ticketId: ticket.id,
        number: 1,
        channelId: CREATED,
      },
    ]);
  });

  test('the context becomes form answers on the ticket and in its welcome card', async () => {
    const h = harness();
    await h.press(requestEvent());

    const ticket = h.ticket();
    const saved = await h.store.listAnswers(ticket.id);
    expect(saved.map((entry) => [entry.label, entry.value])).toEqual([
      ['Form', 'Moderator Application'],
      ['Reference', '#12'],
    ]);

    const welcome = JSON.stringify(h.sentIn(CREATED)[0]);
    expect(welcome).toContain('**Form**\\nModerator Application');
    expect(welcome).toContain('**Reference**\\n#12');
  });

  test('the member owns it and the reviewers are added, so the member keeps their place', async () => {
    const h = harness();
    await h.press(requestEvent({ participantIds: [REVIEWER, OTHER_HELPER] }));

    const participants = await h.store.listParticipants(h.ticket().id);
    expect(participants.map((entry) => [entry.userId, entry.kind])).toEqual([
      [APPLICANT, 'opener'],
      [REVIEWER, 'added'],
      [OTHER_HELPER, 'added'],
    ]);
  });

  test('announces the ticket with its source, so the asking module can follow it', async () => {
    const h = harness();
    await h.press(requestEvent());

    const opened = h.published.find((entry) => entry.type === 'tickets.opened');
    expect(ticketOpenedEventSchema.parse(opened?.payload)).toMatchObject({
      openerId: REVIEWER,
      source: { module: 'applications', ref: 'app-1' },
    });

    const closed = await closeTicket({
      ctx: h.context(),
      store: h.store,
      deps: h.deps,
      ticket: h.ticket(),
      closedBy: REVIEWER,
      reason: null,
      idempotencyKey: 'close-1',
    });
    expect(closed.ok).toBe(true);

    const announced = h.published.find((entry) => entry.type === 'tickets.closed');
    expect(ticketClosedEventSchema.parse(announced?.payload).source).toEqual({
      module: 'applications',
      ref: 'app-1',
    });
  });

  test('a ticket opened from a panel announces no source', async () => {
    const h = harness();
    const open = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
    if (!open.ok) throw new Error(open.humanReason);

    await h.press(pressEvent(open.customId));

    const opened = h.published.find((entry) => entry.type === 'tickets.opened');
    expect(opened?.payload).not.toHaveProperty('source');
    expect(h.ticket().source).toBeNull();
  });

  test('a ticket already open for the source is reused and new reviewers are let in', async () => {
    const h = harness();
    await h.press(requestEvent());
    const first = h.ticket();

    await h.press(requestEvent({ requestId: 'effect-2', participantIds: [OTHER_HELPER] }));

    expect(h.store.rows.size).toBe(1);
    expect(creates(h)).toHaveLength(1);
    expect(answers(h).at(-1)).toMatchObject({
      requestId: 'effect-2',
      status: 'reused',
      ticketId: first.id,
      channelId: CREATED,
    });

    const participants = await h.store.listParticipants(first.id);
    expect(participants.some((entry) => entry.userId === OTHER_HELPER)).toBe(true);
    expect(
      h.rest.calls.some(
        (call) =>
          call.method === 'PUT' && call.path === `/channels/${CREATED}/permissions/${OTHER_HELPER}`,
      ),
    ).toBe(true);
  });

  test('a closed ticket is reopened when its type allows it', async () => {
    const h = harness();
    await h.press(requestEvent());
    const first = h.ticket();
    await h.store.close({ guildId: GUILD, ticketId: first.id, closedBy: REVIEWER, reason: null });

    await h.press(requestEvent({ requestId: 'effect-2' }));

    expect(h.store.rows.size).toBe(1);
    expect(h.ticket().status).toBe('open');
    expect(creates(h)).toHaveLength(1);
    expect(answers(h).at(-1)).toMatchObject({ status: 'reopened', ticketId: first.id });
    expect(h.published.some((entry) => entry.type === 'tickets.reopened')).toBe(true);
  });

  test('a closed ticket whose type does not reopen gives way to a new one', async () => {
    const h = harness({
      config: { types: [ticketTypeSchema.parse({ ...TYPE, reopenEnabled: false })] },
    });
    await h.press(requestEvent());
    const first = h.ticket();
    await h.store.close({ guildId: GUILD, ticketId: first.id, closedBy: REVIEWER, reason: null });

    h.rest.response = { status: 200, body: { id: SECOND } };
    await h.press(requestEvent({ requestId: 'effect-2' }));

    expect(h.store.rows.size).toBe(2);
    expect(creates(h)).toHaveLength(2);

    const answer = answers(h).at(-1);
    expect(answer).toMatchObject({ status: 'opened', number: 2, channelId: SECOND });
    expect(answer?.ticketId).not.toBe(first.id);

    const linked = await h.store.bySource(GUILD, 'applications', 'app-1');
    expect(linked?.number).toBe(2);
  });

  test('an older ticket cannot be reopened by hand while a newer one is open for the source', async () => {
    const h = harness({
      config: { types: [ticketTypeSchema.parse({ ...TYPE, reopenEnabled: false })] },
    });
    await h.press(requestEvent());
    const first = h.ticket();
    await h.store.close({ guildId: GUILD, ticketId: first.id, closedBy: REVIEWER, reason: null });

    h.rest.response = { status: 200, body: { id: SECOND } };
    await h.press(requestEvent({ requestId: 'effect-2' }));

    const closed = await h.store.get(GUILD, first.id);
    if (!closed) throw new Error('the first ticket is gone');

    const outcome = await reopenTicket(h.context(), h.store, closed, REVIEWER);

    expect(outcome).toEqual({
      ok: false,
      humanReason:
        'Ticket #1 can’t be reopened while ticket #2 is open for the same request. Use that one ' +
        'instead.',
    });
    expect((await h.store.get(GUILD, first.id))?.status).toBe('closed');
  });

  test('the same request delivered twice opens one ticket and names it both times', async () => {
    const h = harness();
    const event = requestEvent();

    await h.press(event);
    await h.press(event);

    expect(h.store.rows.size).toBe(1);
    expect(creates(h)).toHaveLength(1);

    const named = answers(h).map((entry) => entry.ticketId);
    expect(named).toEqual([h.ticket().id, h.ticket().id]);
  });

  test('a different source gets its own ticket', async () => {
    const h = harness();
    await h.press(requestEvent());

    h.rest.response = { status: 200, body: { id: SECOND } };
    await h.press(requestEvent({ requestId: 'effect-2', sourceRef: 'app-2' }));

    expect(h.store.rows.size).toBe(2);
  });
});

describe('the member limits do not apply to a ticket staff asked for', () => {
  test('a blacklisted member at the cap and inside the cooldown still gets the ticket', async () => {
    const h = harness({ config: { maxOpenPerUser: 1, creationCooldown: '1h' } });
    const open = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
    if (!open.ok) throw new Error(open.humanReason);

    await h.press(pressEvent(open.customId));
    expect(h.store.rows.size).toBe(1);

    await h.store.blacklist({
      guildId: GUILD,
      userId: APPLICANT,
      reason: 'spam',
      createdBy: REVIEWER,
      expiresAt: null,
    });

    h.rest.response = { status: 200, body: { id: SECOND } };
    await h.press(requestEvent());

    expect(h.store.rows.size).toBe(2);
    expect(answers(h)).toMatchObject([{ status: 'opened', channelId: SECOND }]);
  });

  test('the server-wide cap still applies, because it protects the server and not the member', async () => {
    const h = harness({ config: { maxOpenPerGuild: 1 } });
    const open = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
    if (!open.ok) throw new Error(open.humanReason);
    await h.press(pressEvent(open.customId, { userId: OTHER_HELPER }));

    await h.press(requestEvent());

    expect(h.store.rows.size).toBe(1);
    expect(answers(h)).toMatchObject([{ status: 'refused' }]);
    expect(answers(h)[0]?.reason).toContain('open tickets');
  });
});

describe('refusing a request, with a reason', () => {
  test('Tickets off answers refused and makes nothing', async () => {
    const h = harness({ config: { enabled: false } });
    await h.press(requestEvent());

    expect(h.store.rows.size).toBe(0);
    expect(creates(h)).toHaveLength(0);
    expect(answers(h)).toEqual([
      {
        guildId: GUILD,
        requestId: 'effect-1',
        sourceModule: 'applications',
        sourceRef: 'app-1',
        status: 'refused',
        reason: TICKETS_OFF_REASON,
      },
    ]);
    expect(h.published.find((entry) => entry.type === 'tickets.open_answered')?.naturalKey).toBe(
      'effect-1:refused',
    );
  });

  test('a ticket type that no longer exists is named in the refusal', async () => {
    const h = harness();
    await h.press(requestEvent({ typeId: 'interview' }));

    expect(h.store.rows.size).toBe(0);
    expect(answers(h)).toMatchObject([{ status: 'refused' }]);
    expect(answers(h)[0]?.reason).toBe(
      'There’s no ticket type with the ID “interview” in this server’s Tickets settings.',
    );
  });

  test('a Tickets built without its store refuses in plain words and logs what is missing', async () => {
    const h = harness();
    const { store: _unbound, ...deps } = h.deps;

    await h.press(requestEvent(), { deps });

    expect(answers(h)).toMatchObject([{ status: 'refused', reason: TICKETS_UNAVAILABLE_REASON }]);
    expect(
      h.logs.some((entry) => entry.level === 'error' && entry.message.includes('without store')),
    ).toBe(true);
  });

  test('a request for another server is ignored and not answered', async () => {
    const h = harness();
    await h.press(requestEvent({ guildId: '900000000000000002' }));

    expect(h.store.rows.size).toBe(0);
    expect(answers(h)).toEqual([]);
  });

  test('a request it cannot read is ignored and not answered', async () => {
    const h = harness();
    await h.press(requestEvent({ ownerId: 'not-a-snowflake' }));

    expect(h.store.rows.size).toBe(0);
    expect(answers(h)).toEqual([]);
    expect(h.logs.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('a create Discord may or may not have carried out', () => {
  test('keeps the reserved row and answers nothing, rather than guessing', async () => {
    const h = harness();
    unreachableCreates(h);

    await h.press(requestEvent());

    const ticket = h.ticket();
    expect(ticket.channelId).toBe(ticket.id);
    expect(ticket.source).toEqual({ module: 'applications', ref: 'app-1' });
    expect(answers(h)).toEqual([]);
    expect(h.logs.some((entry) => entry.message.includes('may or may not have its channel'))).toBe(
      true,
    );
  });

  test('asking again finds the channel by name and attaches it instead of making another', async () => {
    const h = harness();
    unreachableCreates(h);
    await h.press(requestEvent());

    const name = firstCreate(h).name ?? '';
    expect(name).not.toBe('');

    await h.press(requestEvent(), { deps: withChannel(h, { id: CREATED, name }) });

    expect(creates(h)).toHaveLength(1);
    expect(h.store.rows.size).toBe(1);
    expect(h.ticket().channelId).toBe(CREATED);
    expect(answers(h)).toMatchObject([{ status: 'opened', channelId: CREATED }]);
  });

  test('asking again with no such channel makes it, on the same row', async () => {
    const h = harness();
    const network = unreachableCreates(h);
    await h.press(requestEvent());
    const reserved = h.ticket();

    network.restore();
    await h.press(requestEvent({ requestId: `effect-${newId()}` }));

    expect(creates(h)).toHaveLength(2);
    expect(h.store.rows.size).toBe(1);
    expect(h.ticket().id).toBe(reserved.id);
    expect(h.ticket().channelId).toBe(CREATED);
    expect(answers(h)).toMatchObject([{ status: 'opened', ticketId: reserved.id }]);
  });

  test('the patrol books no timers for a row that has no channel yet', async () => {
    const h = harness({
      config: { types: [ticketTypeSchema.parse({ ...TYPE, autoCloseAfter: '1h' })] },
    });
    unreachableCreates(h);
    await h.press(requestEvent());

    await patrol(h.context(), h.deps, h.now());

    const reserved = h.ticket();
    expect(h.scheduled.filter((entry) => entry.naturalKey === reserved.id)).toEqual([]);
  });

  test('a channel with the same name that the member cannot see is never taken over', async () => {
    const h = harness();
    unreachableCreates(h);
    await h.press(requestEvent());
    const name = firstCreate(h).name ?? '';

    const deps = withChannel(h, { id: SECOND, name });
    const inner = deps.guildState;
    const stranger: TicketsDeps = {
      ...deps,
      guildState: {
        get: async (guildId) => {
          const state = (await inner?.get(guildId)) ?? null;
          const channel = state?.channels.get(SECOND);
          if (channel) channel.overwrites = [];
          return state;
        },
        put: async () => undefined,
        patch: async () => undefined,
        delete: async () => undefined,
      },
    };

    await h.press(requestEvent(), { deps: stranger });

    expect(h.ticket().channelId).toBe(h.ticket().id);
    expect(answers(h)).toEqual([]);
  });
});
