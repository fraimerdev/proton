import { describe, expect, test } from 'bun:test';
import { encodeCustomId, newId } from '@proton/core';
import { ticketTypeSchema } from '../src/config.ts';
import { createTicketsModule } from '../src/index.ts';
import { patrol } from '../src/reconcile.ts';
import {
  AUTO_CLOSE_JOB,
  AUTO_DELETE_JOB,
  CLOSE_REQUEST_JOB,
  INACTIVITY_WARN_JOB,
  PER_TICKET_JOBS,
  SWEEP_JOB,
} from '../src/schedule.ts';
import {
  GUILD,
  HELPER,
  harness,
  MEMBER,
  MOD,
  messageEvent,
  PANEL,
  pressEvent,
  STAFF,
  SUPPORT_ROLE,
  subcommand,
  TYPE,
} from './harness.ts';

const OPEN_ID = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
const OPEN = OPEN_ID.ok ? OPEN_ID.customId : '';

const HOUR = 60 * 60 * 1000;

function typed(extra: Record<string, unknown>) {
  return { types: [ticketTypeSchema.parse({ ...TYPE, ...extra })] };
}

function jobsFor(h: ReturnType<typeof harness>, jobId: string) {
  return h.scheduled.filter((entry) => entry.jobId === jobId);
}

async function open(h: ReturnType<typeof harness>) {
  await h.press(pressEvent(OPEN));
  return h.ticket();
}

function handlerFor(h: ReturnType<typeof harness>, jobId: string) {
  const handler = createTicketsModule(h.deps).scheduledHandlers?.[jobId];
  if (!handler) throw new Error(`no handler for ${jobId}`);
  return handler;
}

describe('arming timers when a ticket opens', () => {
  test('a type that asks for nothing books nothing, so no row is written at all', async () => {
    const h = harness();
    await open(h);

    expect(jobsFor(h, AUTO_CLOSE_JOB)).toHaveLength(0);
    expect(jobsFor(h, INACTIVITY_WARN_JOB)).toHaveLength(0);
  });

  test('auto-close is booked from the last activity when the type asks for it', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    const booked = jobsFor(h, AUTO_CLOSE_JOB).at(-1);
    expect(booked?.naturalKey).toBe(ticket.id);
    expect(booked?.runAt.getTime()).toBe(ticket.lastActivityAt.getTime() + 2 * HOUR);
  });

  test('every arm replaces, or a moved deadline would silently keep the old one', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h', inactivityWarnAfter: '1h' }) });
    await open(h);

    for (const entry of h.scheduled) {
      expect(entry.options?.replace).toBe(true);
    }
  });

  test('a deployment with no durable scheduler says so by name rather than failing silently', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    await h.press(pressEvent(OPEN), { scheduler: false });

    expect(h.scheduled).toHaveLength(0);
    expect(h.logs.some((entry) => entry.message.includes('durable scheduler'))).toBe(true);
  });
});

describe('the auto-close job', () => {
  test('re-arms instead of closing when somebody spoke since the job was booked', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    h.advance(30 * 60 * 1000);
    await h.press(messageEvent(ticket.channelId));

    const before = h.scheduled.length;
    await handlerFor(h, AUTO_CLOSE_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('open');
    expect(h.scheduled.length).toBeGreaterThan(before);
  });

  test('closes once the deadline really has passed', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    h.advance(3 * HOUR);
    await handlerFor(h, AUTO_CLOSE_JOB)({ ticketId: ticket.id }, h.context());

    const closed = await h.store.get(GUILD, ticket.id);
    expect(closed?.status).toBe('closed');
    expect(closed?.closeReason).toContain('automatically');
  });

  test('names Proton rather than a raw id, so the log does not read "<@tickets>"', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    h.advance(3 * HOUR);
    await handlerFor(h, AUTO_CLOSE_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.closedBy).toBe('proton:tickets');
  });

  test('a job carrying no ticket id is logged and does nothing', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    await open(h);

    await handlerFor(h, AUTO_CLOSE_JOB)({}, h.context());

    expect(h.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  test('a job for a ticket that has since been deleted does nothing', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);
    await h.store.markDeleted(GUILD, ticket.id, MOD.userId ?? MEMBER, null);

    await handlerFor(h, AUTO_CLOSE_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('deleted');
  });
});

describe('the inactivity warning', () => {
  test('warns the member when the ticket is waiting on them', async () => {
    const h = harness({ config: typed({ inactivityWarnAfter: '1h' }) });
    const ticket = await open(h);

    await h.press(messageEvent(ticket.channelId, { userId: HELPER, roleIds: [SUPPORT_ROLE] }));
    h.advance(2 * HOUR);
    await handlerFor(h, INACTIVITY_WARN_JOB)({ ticketId: ticket.id }, h.context());

    expect(
      h.sentIn(ticket.channelId).some((body) => String(body.content).includes('still need help')),
    ).toBe(true);
  });

  test('never warns while the ticket is waiting on staff, which would blame the member for the queue', async () => {
    const h = harness({ config: typed({ inactivityWarnAfter: '1h' }) });
    const ticket = await open(h);

    await h.press(messageEvent(ticket.channelId, { userId: MEMBER }));
    h.advance(2 * HOUR);
    await handlerFor(h, INACTIVITY_WARN_JOB)({ ticketId: ticket.id }, h.context());

    expect(
      h.sentIn(ticket.channelId).some((body) => String(body.content).includes('still need help')),
    ).toBe(false);
  });
});

describe('cancelling', () => {
  test('closing cancels every per-ticket job, not only the auto-close', async () => {
    const h = harness({
      config: typed({
        autoCloseAfter: '2h',
        inactivityWarnAfter: '1h',
        closeRequestExpiresAfter: '1h',
      }),
    });
    const ticket = await open(h);

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    for (const jobId of PER_TICKET_JOBS) {
      expect(
        h.cancelled.some((entry) => entry.jobId === jobId && entry.naturalKey === ticket.id),
      ).toBe(true);
    }
  });
});

describe('the close request', () => {
  test('an unanswered request closes the ticket when it expires', async () => {
    const h = harness({ config: typed({ closeRequestExpiresAfter: '1h' }) });
    const ticket = await open(h);
    await h.store.requestClose(GUILD, ticket.id, HELPER);

    await handlerFor(h, CLOSE_REQUEST_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('closed');
  });

  test('a request the member declined leaves the ticket open when the job fires', async () => {
    const h = harness({ config: typed({ closeRequestExpiresAfter: '1h' }) });
    const ticket = await open(h);
    await h.store.requestClose(GUILD, ticket.id, HELPER);
    await h.store.clearCloseRequest(GUILD, ticket.id);

    await handlerFor(h, CLOSE_REQUEST_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('open');
  });
});

describe('auto-delete', () => {
  test('a closed ticket is tidied up once its type says it should be', async () => {
    const h = harness({ config: typed({ autoDeleteAfter: '24h' }) });
    const ticket = await open(h);
    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    await handlerFor(h, AUTO_DELETE_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('deleted');
  });

  test('a ticket reopened after the job read it is left alone, not destroyed', async () => {
    const h = harness({ config: typed({ autoDeleteAfter: '24h' }) });
    const ticket = await open(h);
    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    // The job reads its row, then the reopen lands before the delete commits. The guard has to be
    // in the UPDATE, because the handler is holding a snapshot that says 'closed'.
    const stale = await h.store.get(GUILD, ticket.id);
    if (!stale) throw new Error('the ticket vanished');

    await h.store.reopen(GUILD, ticket.id, MEMBER);

    const { deleteTicket } = await import('../src/lifecycle.ts');
    const outcome = await deleteTicket(
      h.context(),
      h.store,
      h.deps,
      stale,
      'proton:tickets',
      'tidied up automatically',
      ['closed', 'archived'],
    );

    expect(outcome.ok).toBe(false);
    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('open');
  });

  test('an open ticket is never deleted by the tidy-up job', async () => {
    const h = harness({ config: typed({ autoDeleteAfter: '24h' }) });
    const ticket = await open(h);

    await handlerFor(h, AUTO_DELETE_JOB)({ ticketId: ticket.id }, h.context());

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('open');
  });
});

describe('the patrol', () => {
  test('books a timer for a ticket whose type gained one after it was already open', async () => {
    const h = harness();
    const ticket = await open(h);
    expect(jobsFor(h, AUTO_CLOSE_JOB)).toHaveLength(0);

    const later = h.context({ config: typed({ autoCloseAfter: '2h' }) });
    await patrol(later, h.deps, h.now());

    expect(jobsFor(h, AUTO_CLOSE_JOB).some((entry) => entry.naturalKey === ticket.id)).toBe(true);
  });

  test('re-arms itself, so a stopped patrol does not stay stopped', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    await open(h);

    await patrol(h.context(), h.deps, h.now());

    expect(jobsFor(h, SWEEP_JOB).some((entry) => entry.naturalKey === 'patrol')).toBe(true);
  });

  test('books nothing at all for a server whose types ask for no timers', async () => {
    const h = harness();
    await open(h);

    await patrol(h.context(), h.deps, h.now());

    expect(jobsFor(h, SWEEP_JOB)).toHaveLength(0);
  });

  test('drops captured messages once their retention has run out', async () => {
    const h = harness({ config: typed({ captureMessages: true }) });
    const ticket = await open(h);

    await h.store.captureMessage({
      ticketId: ticket.id,
      messageId: '700000000000000055',
      authorId: MEMBER,
      authorName: 'Member',
      authorBot: false,
      content: 'hello',
      attachments: [],
      embeds: [],
      replyToId: null,
      createdAt: h.now(),
      expiresAt: new Date(h.now().getTime() - 1000),
    });

    expect(await h.store.listMessages(ticket.id)).toHaveLength(1);
    const result = await patrol(h.context(), h.deps, h.now());

    expect(result.purged).toBe(1);
    expect(await h.store.listMessages(ticket.id)).toHaveLength(0);
  });
});

describe('activity and who is waiting', () => {
  test('a staff reply flips the ticket to waiting on the member', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    await h.press(messageEvent(ticket.channelId, { userId: HELPER, roleIds: [SUPPORT_ROLE] }));

    expect((await h.store.get(GUILD, ticket.id))?.waitingOn).toBe('user');
  });

  test('a member reply flips it back to waiting on staff', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    await h.press(messageEvent(ticket.channelId, { userId: HELPER, roleIds: [SUPPORT_ROLE] }));
    await h.press(messageEvent(ticket.channelId, { userId: MEMBER }));

    expect((await h.store.get(GUILD, ticket.id))?.waitingOn).toBe('staff');
  });

  test('the first staff reply is the one timed, so a later one cannot flatter the average', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    h.advance(5 * 60 * 1000);
    await h.press(messageEvent(ticket.channelId, { userId: HELPER, roleIds: [SUPPORT_ROLE] }));
    const first = (await h.store.get(GUILD, ticket.id))?.firstResponseAt;

    h.advance(60 * 60 * 1000);
    await h.press(messageEvent(ticket.channelId, { userId: HELPER, roleIds: [SUPPORT_ROLE] }));

    expect((await h.store.get(GUILD, ticket.id))?.firstResponseAt?.getTime()).toBe(
      first?.getTime(),
    );
  });

  test('the member who raised it is never counted as staff, even holding a support role', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    await h.press(messageEvent(ticket.channelId, { userId: MEMBER, roleIds: [SUPPORT_ROLE] }));

    const after = await h.store.get(GUILD, ticket.id);
    expect(after?.waitingOn).toBe('staff');
    expect(after?.firstResponseAt).toBeNull();
  });

  test('nothing is captured unless the type asks for it, which is the retention decision', async () => {
    const h = harness({ config: typed({ autoCloseAfter: '2h' }) });
    const ticket = await open(h);

    await h.press(messageEvent(ticket.channelId, { userId: MEMBER }));

    expect(await h.store.listMessages(ticket.id)).toHaveLength(0);
  });

  test('a capturing type stores the message with an expiry thirty days out', async () => {
    const h = harness({ config: typed({ captureMessages: true }) });
    const ticket = await open(h);

    await h.press(
      messageEvent(ticket.channelId, { userId: MEMBER, content: 'my printer is on fire' }),
    );

    const messages = await h.store.listMessages(ticket.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('my printer is on fire');
  });

  test('a guild with no capturing and no timers pays no database read per message', async () => {
    const h = harness();
    const ticket = await open(h);
    const before = h.store.reads;

    await h.press(messageEvent(ticket.channelId, { userId: MEMBER }));

    expect(h.store.reads).toBe(before);
  });

  test('a staff press cannot be attributed to somebody else by forging the event id', async () => {
    const h = harness();
    const ticket = await open(h);

    await h.press(
      pressEvent(customIdFor('claim'), { ...STAFF, channelId: ticket.channelId, eventId: newId() }),
    );

    expect((await h.store.get(GUILD, ticket.id))?.claimedById).toBe(HELPER);
  });
});

function customIdFor(action: string): string {
  const encoded = encodeCustomId('tickets', action);
  if (!encoded.ok) throw new Error(encoded.humanReason);
  return encoded.customId;
}
