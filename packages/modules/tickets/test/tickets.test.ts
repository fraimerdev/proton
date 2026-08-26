import { describe, expect, test } from 'bun:test';
import { encodeCustomId, newId, Permissions } from '@proton/core';
import { ticketTypeSchema } from '../src/config.ts';
import { handleChannelDeleted } from '../src/reconcile.ts';
import {
  ADMIN,
  BOT_PERMISSIONS,
  CATEGORY,
  CREATED,
  GUILD,
  HELPER,
  harness,
  integerOption,
  MEMBER,
  MOD,
  OTHER_STAFF,
  PANEL,
  PANEL_CHANNEL,
  pressEvent,
  STAFF,
  SUPPORT_ROLE,
  stringOption,
  subcommand,
  TRANSCRIPTS,
  TYPE,
  userOption,
} from './harness.ts';

const OPEN_PRESS = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
const LEGACY_PRESS = encodeCustomId('tickets', 'open', PANEL.id);

function customId(action: string, ...args: string[]): string {
  const encoded = encodeCustomId('tickets', action, ...args);
  if (!encoded.ok) throw new Error(encoded.humanReason);
  return encoded.customId;
}

const OPEN = OPEN_PRESS.ok ? OPEN_PRESS.customId : '';
const LEGACY = LEGACY_PRESS.ok ? LEGACY_PRESS.customId : '';

function createCall(h: ReturnType<typeof harness>): Record<string, unknown> | undefined {
  const call = h
    .calls()
    .find((entry) => entry.method === 'POST' && entry.path === `/guilds/${GUILD}/channels`);

  return call?.body as Record<string, unknown> | undefined;
}

async function openOne(h: ReturnType<typeof harness>) {
  await h.press(pressEvent(OPEN));
  return h.store.rows.values().next().value;
}

describe('opening a ticket from a panel', () => {
  test('a press opens a private channel and records the ticket against its opener', async () => {
    const h = harness();
    await h.press(pressEvent(OPEN));

    const ticket = h.ticket();
    expect(ticket.number).toBe(1);
    expect(ticket.typeId).toBe(TYPE.id);
    expect(ticket.ownerId).toBe(MEMBER);
    expect(ticket.openerId).toBe(MEMBER);
    expect(ticket.status).toBe('open');
    expect(ticket.channelId).toBe(CREATED);
  });

  test('the overwrites travel in the create body, so the channel is never briefly public', () => {
    const h = harness();

    return h.press(pressEvent(OPEN)).then(() => {
      const body = createCall(h);
      const overwrites = body?.permission_overwrites as Array<Record<string, unknown>>;

      expect(overwrites).toBeDefined();
      const everyone = overwrites.find((entry) => entry.id === GUILD);
      expect(BigInt(String(everyone?.deny ?? '0')) & Permissions.ViewChannel).toBe(
        Permissions.ViewChannel,
      );
      expect(overwrites.some((entry) => entry.id === MEMBER)).toBe(true);
      expect(overwrites.some((entry) => entry.id === SUPPORT_ROLE)).toBe(true);
    });
  });

  test('the ticket lands in the category its type names, which is how routing is visible', async () => {
    const h = harness();
    await h.press(pressEvent(OPEN));

    expect(createCall(h)?.parent_id).toBe(CATEGORY);
  });

  test('the opener is recorded as a participant, so the transcript knows who was in it', async () => {
    const h = harness();
    await h.press(pressEvent(OPEN));

    const participants = await h.store.listParticipants(h.ticket().id);
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ userId: MEMBER, kind: 'opener' });
  });

  test('a legacy one-argument panel button still opens, or every posted panel would break', async () => {
    const h = harness();
    await h.press(pressEvent(LEGACY));

    expect(h.store.rows.size).toBe(1);
  });

  test('the module announces the ticket, so serverlog and statistics can see it', async () => {
    const h = harness();
    await h.press(pressEvent(OPEN));

    const opened = h.published.find((entry) => entry.type === 'tickets.opened');
    expect(opened).toBeDefined();
    expect(opened?.payload).toMatchObject({ guildId: GUILD, number: 1, openerId: MEMBER });
  });

  test('a button for a type that has since been deleted refuses and opens nothing', async () => {
    const h = harness({ config: { types: [] } });
    await h.press(pressEvent(OPEN));

    expect(h.store.rows.size).toBe(0);
    expect(h.lastTold()).toContain('nothing to open');
  });

  test('a button for a panel that has since been deleted refuses and opens nothing', async () => {
    const h = harness({ config: { panels: [] } });
    await h.press(pressEvent(OPEN));

    expect(h.store.rows.size).toBe(0);
    expect(h.lastTold()).toContain('no longer exists');
  });

  test('a press while the module is off is answered, not dropped into "interaction failed"', async () => {
    const h = harness({ config: { enabled: false } });
    await h.press(pressEvent(OPEN));

    expect(h.told().join(' ')).toContain('switched off');
  });
});

describe('intake forms', () => {
  const withForm = {
    types: [
      ticketTypeSchema.parse({
        ...TYPE,
        form: [
          { id: 'what', label: 'What happened?', style: 'short', required: true, options: [] },
        ],
      }),
    ],
  };

  test('a type with a form answers with a modal first, because a modal cannot follow a defer', async () => {
    const h = harness({ config: withForm });
    await h.press(pressEvent(OPEN));

    expect(h.callbackTypes()).toEqual([9]);
    expect(h.store.rows.size).toBe(0);
  });

  test('submitting the form opens the ticket and stores the answers against it', async () => {
    const h = harness({ config: withForm });
    await h.press(pressEvent(OPEN));
    await h.submit(customId('form', PANEL.id, TYPE.id), { what: 'cannot log in' });

    const ticket = h.ticket();
    expect(ticket.subject).toBe('cannot log in');

    const answers = await h.store.listAnswers(ticket.id);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ fieldId: 'what', value: 'cannot log in' });
  });

  test('a form submitted for a type deleted in the meantime records nothing', async () => {
    const h = harness({ config: { types: [] } });
    await h.submit(customId('form', PANEL.id, TYPE.id), { what: 'hello' });

    expect(h.store.rows.size).toBe(0);
    expect(h.told().join(' ')).toContain('removed');
  });
});

describe('the limits that stop a member flooding the queue', () => {
  test('a member at the per-server cap is refused and told to close one first', async () => {
    const h = harness({ config: { maxOpenPerUser: 1, creationCooldown: '0s' } });
    await h.press(pressEvent(OPEN));
    await h.press(pressEvent(OPEN, { eventId: newId() }));

    expect(h.store.rows.size).toBe(1);
    expect(h.lastTold()).toContain('already have');
  });

  test('a per-type cap refuses that type while another type still opens', async () => {
    const other = ticketTypeSchema.parse({ id: 'billing', name: 'Billing' });
    const h = harness({
      config: {
        creationCooldown: '0s',
        types: [ticketTypeSchema.parse({ ...TYPE, maxOpenPerUser: 1 }), other],
        panels: [{ ...PANEL, typeIds: [TYPE.id, other.id] }],
      },
    });

    await h.press(pressEvent(OPEN));
    await h.press(pressEvent(OPEN, { eventId: newId() }));
    expect(h.store.rows.size).toBe(1);

    await h.press(pressEvent(customId('ot', PANEL.id, other.id), { eventId: newId() }));
    expect(h.store.rows.size).toBe(2);
  });

  test('the cooldown names the wait rather than failing silently', async () => {
    const h = harness({ config: { creationCooldown: '30s' } });
    await h.press(pressEvent(OPEN));
    await h.press(pressEvent(OPEN, { eventId: newId() }));

    expect(h.store.rows.size).toBe(1);
    expect(h.lastTold()).toContain('wait');
  });

  test('the cooldown lapses, so the same member can open another once it has passed', async () => {
    const h = harness({ config: { creationCooldown: '30s' } });
    await h.press(pressEvent(OPEN));
    h.advance(31_000);
    await h.press(pressEvent(OPEN, { eventId: newId() }));

    expect(h.store.rows.size).toBe(2);
  });

  test('a blacklisted member is refused with the server’s own wording and a reason', async () => {
    const h = harness({ config: { blacklistMessage: 'You are blocked.', creationCooldown: '0s' } });
    await h.store.blacklist({
      guildId: GUILD,
      userId: MEMBER,
      reason: 'spam',
      createdBy: HELPER,
      expiresAt: null,
    });

    await h.press(pressEvent(OPEN));

    expect(h.store.rows.size).toBe(0);
    expect(h.lastTold()).toContain('You are blocked.');
    expect(h.lastTold()).toContain('spam');
  });

  test('an expired blacklist entry does not block, or a temporary ban would be permanent', async () => {
    const h = harness({ config: { creationCooldown: '0s' } });
    await h.store.blacklist({
      guildId: GUILD,
      userId: MEMBER,
      reason: null,
      createdBy: HELPER,
      expiresAt: new Date(h.now().getTime() - 1000),
    });

    await h.press(pressEvent(OPEN));
    expect(h.store.rows.size).toBe(1);
  });
});

describe('two things happening at once', () => {
  test('a redelivered press opens exactly one ticket and leaves no reserved row behind', async () => {
    const h = harness({ config: { creationCooldown: '0s' } });
    const event = pressEvent(OPEN);

    await h.press(event);
    await h.press(event);

    expect(h.store.rows.size).toBe(1);
  });

  test('a double-click is two separate interactions and still yields only one ticket', async () => {
    const h = harness({ config: { maxOpenPerUser: 1, creationCooldown: '0s' } });

    // Two distinct event ids, so the executor's dedupe never sees them as the same press. Only the
    // re-check after the row is written can stop the second one.
    await Promise.all([
      h.press(pressEvent(OPEN, { eventId: newId() })),
      h.press(pressEvent(OPEN, { eventId: newId() })),
    ]);

    expect(await h.store.countOpenFor(GUILD, MEMBER)).toBe(1);
  });

  test('a per-type cap survives a double-click on that type', async () => {
    const h = harness({
      config: {
        creationCooldown: '0s',
        types: [{ ...TYPE, maxOpenPerUser: 1 }],
      },
    });

    await Promise.all([
      h.press(pressEvent(OPEN, { eventId: newId() })),
      h.press(pressEvent(OPEN, { eventId: newId() })),
    ]);

    expect(await h.store.countOpenForType(GUILD, MEMBER, TYPE.id)).toBe(1);
  });

  test('two staff claiming at once produce one claimant, and the loser is told who won', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.press(pressEvent(customId('claim'), { ...STAFF, channelId: ticket.channelId }));
    await h.press(
      pressEvent(customId('claim'), {
        ...OTHER_STAFF,
        channelId: ticket.channelId,
        eventId: newId(),
      }),
    );

    expect((await h.store.get(GUILD, ticket.id))?.claimedById).toBe(HELPER);
    expect(h.lastTold()).toContain('claimed this ticket first');
  });

  test('closing twice is idempotent: one transcript, one closing message', async () => {
    const h = harness({ config: { transcriptChannelId: TRANSCRIPTS } });
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });
    await h.run(subcommand('close', [integerOption('number', ticket.number)]), {
      ...MOD,
      idempotencyKey: newId(),
    });

    expect(h.sentIn(TRANSCRIPTS)).toHaveLength(1);

    const closing = h
      .sentIn(ticket.channelId)
      .filter((body) => body.content === h.context().config.closeConfirmation);

    expect(closing).toHaveLength(1);
  });
});

describe('the lifecycle after a ticket is answered', () => {
  test('closing does not delete the channel, which is what makes reopening possible', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('closed');
    expect(
      h.calls().some((call) => call.method === 'DELETE' && call.path === `/channels/${CREATED}`),
    ).toBe(false);
  });

  test('closing takes the member’s ability to post while leaving them able to read', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    const lock = h
      .calls()
      .find((call) => call.method === 'PUT' && call.path.endsWith(`/permissions/${MEMBER}`));
    const body = lock?.body as Record<string, unknown>;

    expect(BigInt(String(body?.deny ?? '0')) & Permissions.SendMessages).toBe(
      Permissions.SendMessages,
    );
    expect(BigInt(String(body?.allow ?? '0')) & Permissions.ViewChannel).toBe(
      Permissions.ViewChannel,
    );
  });

  test('reopening restores the member’s access and puts the ticket back in the queue', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });
    await h.run(subcommand('reopen'), {
      ...MOD,
      channelId: ticket.channelId,
      idempotencyKey: newId(),
    });

    const reopened = await h.store.get(GUILD, ticket.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.closedAt).toBeNull();
    expect(h.published.some((entry) => entry.type === 'tickets.reopened')).toBe(true);
  });

  test('closing a reopened ticket runs the whole close again, not a swallowed replay', async () => {
    const h = harness({ config: { transcriptChannelId: TRANSCRIPTS } });
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });
    h.advance(1000);
    await h.run(subcommand('reopen'), {
      ...MOD,
      channelId: ticket.channelId,
      idempotencyKey: newId(),
    });
    h.advance(1000);
    await h.run(subcommand('close'), {
      ...MOD,
      channelId: ticket.channelId,
      idempotencyKey: newId(),
    });

    // Two closes means two of everything the close does. An idempotency key naming only the ticket
    // made the second close post nothing and leave the member able to post in a closed ticket.
    expect(h.sentIn(TRANSCRIPTS)).toHaveLength(2);

    const locks = h
      .calls()
      .filter((call) => call.method === 'PUT' && call.path.endsWith(`/permissions/${MEMBER}`));

    expect(locks.length).toBeGreaterThanOrEqual(3);
  });

  test('a reopen after a reopen restores posting again, rather than being read as a replay', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    for (let round = 0; round < 2; round += 1) {
      h.advance(1000);
      await h.run(subcommand('close'), {
        ...MOD,
        channelId: ticket.channelId,
        idempotencyKey: newId(),
      });
      h.advance(1000);
      await h.run(subcommand('reopen'), {
        ...MOD,
        channelId: ticket.channelId,
        idempotencyKey: newId(),
      });
    }

    const unlocks = h
      .calls()
      .filter(
        (call) =>
          call.method === 'PUT' &&
          call.path.endsWith(`/permissions/${MEMBER}`) &&
          BigInt(String((call.body as Record<string, unknown>)?.deny ?? '0')) === 0n,
      );

    expect(unlocks).toHaveLength(2);
  });

  test('deleting is a separate act that removes the channel and marks the row deleted', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('delete'), { ...ADMIN, channelId: ticket.channelId });

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('deleted');
    expect(
      h.calls().some((call) => call.method === 'DELETE' && call.path === `/channels/${CREATED}`),
    ).toBe(true);
  });

  test('a support member may close but may not delete, because deleting destroys the record', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('delete'), { ...STAFF, channelId: ticket.channelId });

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('open');
    expect(h.replyContent()).toContain('cannot do that');
  });

  test('locking stops the member posting without closing the ticket', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('lock'), { ...STAFF, channelId: ticket.channelId });

    const locked = await h.store.get(GUILD, ticket.id);
    expect(locked?.status).toBe('open');
    expect(locked?.lockedAt).not.toBeNull();
  });
});

describe('who may do what', () => {
  test('a passer-by cannot close a ticket by number from outside it', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close', [integerOption('number', ticket.number)]), {
      userId: '100000000000000099',
      channelId: PANEL_CHANNEL,
    });

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('open');
    expect(h.replyContent()).toContain('cannot do that');
  });

  test('the member who raised the ticket may close their own', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('close'), { userId: MEMBER, channelId: ticket.channelId });

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('closed');
  });

  test('a member listing tickets sees only their own, not a directory of who asked for help', async () => {
    const h = harness({ config: { creationCooldown: '0s' } });
    await h.press(pressEvent(OPEN, { userId: MEMBER }));
    await h.press(pressEvent(OPEN, { userId: HELPER, eventId: newId() }));

    await h.run(subcommand('list'), { userId: MEMBER, channelId: PANEL_CHANNEL });

    const shown = h.replyContent() ?? '';
    expect(shown).toContain('1 open ticket');
    expect(shown).toContain('of yours');
    expect(shown).not.toContain(`<@${HELPER}>`);
  });

  test('staff listing tickets see the whole queue, which is the point of the command for them', async () => {
    const h = harness({ config: { creationCooldown: '0s' } });
    await h.press(pressEvent(OPEN, { userId: MEMBER }));
    await h.press(pressEvent(OPEN, { userId: HELPER, eventId: newId() }));

    await h.run(subcommand('list'), { ...STAFF, channelId: PANEL_CHANNEL });

    expect(h.replyContent()).toContain('2 open ticket');
  });

  test('a passer-by cannot post a ticket panel into the server', async () => {
    const h = harness();
    await h.run(subcommand('panel', [stringOption('panel', PANEL.id)]), { userId: MEMBER });

    expect(h.sentIn(PANEL_CHANNEL)).toHaveLength(0);
    expect(h.replyContent()).toContain('permission');
  });
});

describe('participants', () => {
  test('adding a member grants exactly one overwrite and records them', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('add', [userOption('user', HELPER)]), {
      ...STAFF,
      channelId: ticket.channelId,
    });

    expect(
      h
        .calls()
        .some((call) => call.method === 'PUT' && call.path.endsWith(`/permissions/${HELPER}`)),
    ).toBe(true);
    expect((await h.store.listParticipants(ticket.id)).some((p) => p.userId === HELPER)).toBe(true);
  });

  test('the ticket owner cannot be removed, because that would orphan their own ticket', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('remove', [userOption('user', MEMBER)]), {
      ...STAFF,
      channelId: ticket.channelId,
    });

    expect(h.replyContent()).toContain('owns this ticket');
    expect((await h.store.listParticipants(ticket.id)).some((p) => p.userId === MEMBER)).toBe(true);
  });

  test('transferring ownership moves the owner without rewriting who raised it', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    await h.run(subcommand('transfer', [userOption('user', HELPER)]), {
      ...STAFF,
      channelId: ticket.channelId,
    });

    const moved = await h.store.get(GUILD, ticket.id);
    expect(moved?.ownerId).toBe(HELPER);
    expect(moved?.openerId).toBe(MEMBER);
  });
});

describe('when Discord says no', () => {
  test('a refused channel creation leaves no ticket row holding one of the member’s slots', async () => {
    const h = harness();
    h.rest.fail(`/guilds/${GUILD}/channels`, { status: 403, body: { message: 'Missing Access' } });

    await h.press(pressEvent(OPEN));

    expect(h.store.rows.size).toBe(0);
    expect(h.lastTold()).toContain("couldn't open");
  });

  test('a bot without Manage Channels is told which permission is missing, not just that it failed', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageChannels });

    await h.press(pressEvent(OPEN));

    expect(h.store.rows.size).toBe(0);
    expect(h.lastTold()?.toLowerCase()).toContain('manage channels');
  });

  test('a failed transcript still leaves the ticket closed, and says so in the log', async () => {
    const h = harness({ config: { transcriptChannelId: TRANSCRIPTS } });
    await openOne(h);
    const ticket = h.ticket();

    h.rest.fail(`/channels/${TRANSCRIPTS}/messages`, { status: 403, body: { message: 'no' } });
    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('closed');
    expect(
      h.logs.some((entry) => entry.level === 'error' && entry.message.includes('transcript')),
    ).toBe(true);
  });
});

describe('reconciling with Discord', () => {
  test('a channel deleted by hand frees the member’s slot instead of holding it forever', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    const outcome = await handleChannelDeleted(
      {
        id: newId(),
        type: 'channel.deleted',
        guildId: GUILD,
        occurredAt: Date.now(),
        payload: { id: ticket.channelId },
      },
      h.context(),
      h.deps,
    );

    expect(outcome).toBe('reconciled');
    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('deleted');
    expect(await h.store.countOpenFor(GUILD, MEMBER)).toBe(0);
  });

  test('a redelivered channel deletion changes nothing the second time', async () => {
    const h = harness();
    await openOne(h);
    const ticket = h.ticket();

    const event = {
      id: newId(),
      type: 'channel.deleted' as const,
      guildId: GUILD,
      occurredAt: Date.now(),
      payload: { id: ticket.channelId },
    };

    await handleChannelDeleted(event, h.context(), h.deps);
    expect(await handleChannelDeleted(event, h.context(), h.deps)).toBe('ignored');
  });

  test('a deletion in a channel Proton does not track is ignored', async () => {
    const h = harness();

    expect(
      await handleChannelDeleted(
        {
          id: newId(),
          type: 'channel.deleted',
          guildId: GUILD,
          occurredAt: Date.now(),
          payload: { id: PANEL_CHANNEL },
        },
        h.context(),
        h.deps,
      ),
    ).toBe('ignored');
  });
});
