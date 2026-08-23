import { describe, expect, test } from 'bun:test';
import { type ActionResult, limitFor, Permissions } from '@proton/core';
import { handleActivity } from '../src/activity.ts';
import { handleOpenPress } from '../src/interactions.ts';
import { AUTO_CLOSE_JOB, openTicket } from '../src/lifecycle.ts';
import { OVERWRITE_MEMBER, OVERWRITE_ROLE } from '../src/overwrites.ts';
import { buildPanelMessage } from '../src/panel.ts';
import type { TicketStore } from '../src/store.ts';
import {
  BOT,
  BOT_PERMISSIONS,
  CATEGORY,
  CREATED,
  GUILD,
  HELPER,
  harness,
  integerOption,
  MEMBER,
  messageEvent,
  PANEL,
  PANEL_CHANNEL,
  pressEvent,
  stringOption,
  subcommand,
  TICKET_CHANNEL,
  TRANSCRIPTS,
  userOption,
} from './harness.ts';

function openButton(): string {
  const message = buildPanelMessage(PANEL);
  if (!message.ok) throw new Error('expected a panel message');

  return (message.components[0] as { components: Array<{ custom_id: string }> }).components[0]
    ?.custom_id as string;
}

describe('opening a ticket', () => {
  test('creates the channel private in the same call that creates it', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()));

    const create = h.discordCalls().find((call) => call.path === `/guilds/${GUILD}/channels`);
    const body = create?.body as {
      type: number;
      parent_id?: string;
      permission_overwrites?: Array<{ id: string; type: number; deny?: string; allow?: string }>;
    };

    expect(create?.method).toBe('POST');
    expect(body.type).toBe(0);
    expect(body.parent_id).toBe(CATEGORY);

    expect(body.permission_overwrites).toContainEqual({
      id: GUILD,
      type: OVERWRITE_ROLE,
      deny: Permissions.ViewChannel.toString(),
    });
    expect(
      body.permission_overwrites?.some(
        (entry) => entry.id === MEMBER && entry.type === OVERWRITE_MEMBER,
      ),
    ).toBe(true);
  });

  test('never patches the channel afterwards, which would leave it readable in between', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()));

    expect(h.discordCalls().some((call) => call.method === 'PATCH')).toBe(false);
  });

  test('acknowledges the press before doing any of the slow work', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()));

    const first = h.calls()[0];
    expect(first?.path).toContain('/callback');
    expect((first?.body as { type: number } | undefined)?.type).toBe(5);
  });

  test('records the ticket against the channel Discord made', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()));

    const ticket = await h.store.byChannel(GUILD, CREATED);
    expect(ticket).toMatchObject({
      openerId: MEMBER,
      panelId: PANEL.id,
      number: 1,
      status: 'open',
    });
  });

  test('greets the opener in the new channel without pinging the world', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()));

    const greeting = h.discordCalls().find((call) => call.path === `/channels/${CREATED}/messages`);
    const sent = greeting?.body as { content: string; allowed_mentions: unknown } | undefined;

    expect(sent?.content).toContain(`<@${MEMBER}>`);
    expect(sent?.allowed_mentions).toEqual({
      parse: [],
      users: [MEMBER],
      roles: PANEL.supportRoleIds,
    });
  });

  test('tells the member where their ticket is', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()));

    expect(h.followUpContent()).toContain(`<#${CREATED}>`);
  });

  test('refuses a second ticket at the free tier limit, naming the tier and the way out', async () => {
    const h = harness();
    const cap = limitFor('free', 'openTicketsPerUser');

    for (let index = 0; index < cap; index++) {
      const reserved = await h.store.reserve({
        guildId: GUILD,
        panelId: PANEL.id,
        openerId: MEMBER,
      });
      await h.store.attach(GUILD, reserved.id, `5000000000000001${index}`);
    }

    await h.press(pressEvent(openButton()));

    expect(h.discordCalls().some((call) => call.path === `/guilds/${GUILD}/channels`)).toBe(false);

    const said = h.followUpContent() ?? '';
    expect(said).toContain('free');
    expect(said).toContain(String(cap));

    // A channel deleted by hand leaves the row open and the slot taken, so the refusal has to name
    // the command that clears it — otherwise the member is stuck with nothing to try.
    expect(said).toContain('/ticket close number:');
    expect(said).toContain('/ticket list');
  });

  test('a ticket whose channel was deleted by hand can be cleared by number, freeing the slot', async () => {
    const h = harness();
    const cap = limitFor('free', 'openTicketsPerUser');

    for (let index = 0; index < cap; index++) {
      const reserved = await h.store.reserve({
        guildId: GUILD,
        panelId: PANEL.id,
        openerId: MEMBER,
      });
      await h.store.attach(GUILD, reserved.id, `5000000000000001${index}`);
    }

    await h.run(subcommand('close', [integerOption('number', 1)]), { channelId: PANEL_CHANNEL });

    expect(await h.store.countOpenFor(GUILD, MEMBER)).toBe(cap - 1);
    expect(h.replyContent()).toContain('#1');

    await h.press(pressEvent(openButton()));

    expect(h.discordCalls().some((call) => call.path === `/guilds/${GUILD}/channels`)).toBe(true);
  });

  test('leaves no reserved row behind when Discord refuses the channel', async () => {
    const h = harness();
    h.rest.failCreate = true;

    await h.press(pressEvent(openButton()));

    expect(h.store.rows.size).toBe(0);
    expect(h.followUpContent()).toContain("couldn't open a ticket channel");
  });

  test('names ManageChannels when the bot cannot create channels', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()), {
      botPermissions: BOT_PERMISSIONS & ~Permissions.ManageChannels,
    });

    expect(h.discordCalls().some((call) => call.path === `/guilds/${GUILD}/channels`)).toBe(false);
    expect(h.followUpContent()).toContain('ManageChannels');
    expect(h.store.rows.size).toBe(0);
  });

  test('names ManageRoles when the bot cannot set the overwrites that make it private', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()), {
      botPermissions: BOT_PERMISSIONS & ~Permissions.ManageRoles,
    });

    expect(h.discordCalls().some((call) => call.path === `/guilds/${GUILD}/channels`)).toBe(false);
    expect(h.followUpContent()).toContain('ManageRoles');
  });

  test('says so when the panel has been deleted from the settings', async () => {
    const h = harness();

    await h.press(pressEvent(openButton()), { config: { panels: [] } });

    expect(h.followUpContent()).toContain('no longer exists');
  });

  test('ignores a button that belongs to another module', async () => {
    const h = harness();

    await h.press(pressEvent('proton:rolemenu:menu:key'));

    expect(h.calls()).toHaveLength(0);
  });

  test('a ticket whose row vanishes mid-open is reported, not silently untracked', async () => {
    const h = harness();

    // Delegated by hand rather than spread or Object.create: the memory store keeps its state in
    // a private field, which neither of those carries.
    const store: TicketStore = {
      reserve: (input) => h.store.reserve(input),
      attach: async () => null,
      abandon: (guildId, id) => h.store.abandon(guildId, id),
      get: (guildId, id) => h.store.get(guildId, id),
      byChannel: (guildId, channelId) => h.store.byChannel(guildId, channelId),
      byNumber: (guildId, number) => h.store.byNumber(guildId, number),
      countOpenFor: (guildId, openerId) => h.store.countOpenFor(guildId, openerId),
      listOpen: (guildId) => h.store.listOpen(guildId),
      close: (input) => h.store.close(input),
      touch: (guildId, channelId, notBefore) => h.store.touch(guildId, channelId, notBefore),
    };

    await h.press(pressEvent(openButton()), {
      deps: { store, applicationId: BOT, botUserId: BOT },
    });

    expect(h.followUpContent()).toContain('lost track of it');
    expect(h.followUpContent()).toContain('moderator');
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes(CREATED))).toBe(
      true,
    );
  });

  test('leaves no reserved row behind when the create throws instead of failing', async () => {
    const h = harness();
    const ctx = h.context();

    const outcome = await openTicket({
      ctx: {
        ...ctx,
        executor: {
          execute: async (): Promise<ActionResult> => {
            throw new Error('the dedupe store went away');
          },
        },
      },
      store: h.store,
      deps: { store: h.store, applicationId: BOT, botUserId: BOT },
      panel: PANEL,
      openerId: MEMBER,
      openerName: MEMBER,
      idempotencyKey: 'tickets:throwing-open',
    });

    expect(h.store.rows.size).toBe(0);
    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.humanReason).toContain('Try again');
  });

  test('a redelivered press says nothing more and leaves the first delivery’s ticket alone', async () => {
    const h = harness();
    const deps = { store: h.store, applicationId: BOT, botUserId: BOT };
    const event = pressEvent(openButton());

    const first = await handleOpenPress(event, h.context(), deps);
    const second = await handleOpenPress(event, h.context(), deps);

    expect(first).toEqual({ action: 'opened', channelId: CREATED });
    expect(second.action).not.toBe('refused');

    expect(
      h.discordCalls().filter((call) => call.path === `/guilds/${GUILD}/channels`),
    ).toHaveLength(1);

    expect(h.store.rows.size).toBe(1);
    expect(await h.store.byChannel(GUILD, CREATED)).toMatchObject({ status: 'open', number: 1 });
  });

  test('books the auto-close timer only when the panel asks for one', async () => {
    const without = harness();
    await without.press(pressEvent(openButton()));
    expect(without.scheduled).toHaveLength(0);

    const withTimer = harness();
    await withTimer.press(pressEvent(openButton()), {
      config: { panels: [{ ...PANEL, autoCloseAfter: '48h' }] },
    });

    expect(withTimer.scheduled).toHaveLength(1);
    expect(withTimer.scheduled[0]?.jobId).toBe(AUTO_CLOSE_JOB);
  });
});

describe('closing a ticket', () => {
  async function opened() {
    const h = harness();
    await h.press(pressEvent(openButton()));
    h.rest.calls.length = 0;
    return h;
  }

  test('posts the closing message and removes the channel', async () => {
    const h = await opened();

    await h.run(subcommand('close', [stringOption('reason', 'solved')]), { channelId: CREATED });

    const closing = h.discordCalls().find((call) => call.method === 'POST');
    expect((closing?.body as { content: string } | undefined)?.content).toContain('closed');

    expect(h.discordCalls().find((call) => call.method === 'DELETE')?.path).toBe(
      `/channels/${CREATED}`,
    );
  });

  test('records who closed it and why', async () => {
    const h = await opened();

    await h.run(subcommand('close', [stringOption('reason', 'solved')]), { channelId: CREATED });

    const ticket = [...h.store.rows.values()][0];
    expect(ticket).toMatchObject({ status: 'closed', closedBy: MEMBER, closeReason: 'solved' });
  });

  test('cancels the auto-close timer it booked', async () => {
    const h = harness();
    await h.press(pressEvent(openButton()), {
      config: { panels: [{ ...PANEL, autoCloseAfter: '48h' }] },
    });

    await h.run(subcommand('close'), {
      channelId: CREATED,
      config: { panels: [{ ...PANEL, autoCloseAfter: '48h' }] },
    });

    expect(h.cancelled).toHaveLength(1);
    expect(h.cancelled[0]?.jobId).toBe(AUTO_CLOSE_JOB);
  });

  test('posts a record to the transcript channel when one is configured', async () => {
    const h = harness();
    const panels = [{ ...PANEL, transcriptChannelId: TRANSCRIPTS }];

    await h.press(pressEvent(openButton()), { config: { panels } });
    h.rest.calls.length = 0;

    await h.run(subcommand('close'), { channelId: CREATED, config: { panels } });

    const transcript = h
      .discordCalls()
      .find((call) => call.path === `/channels/${TRANSCRIPTS}/messages`);

    expect((transcript?.body as { content: string } | undefined)?.content).toContain('Ticket #1');
  });

  test('closing twice deletes the channel once', async () => {
    const h = await opened();

    await h.run(subcommand('close'), { channelId: CREATED });
    const after = h.discordCalls().filter((call) => call.method === 'DELETE').length;

    await h.run(subcommand('close'), { channelId: CREATED });

    expect(h.discordCalls().filter((call) => call.method === 'DELETE')).toHaveLength(after);
  });

  test('refuses outside a ticket channel and says where to run it', async () => {
    const h = harness();

    await h.run(subcommand('close'), { channelId: PANEL_CHANNEL });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('inside a ticket channel');
  });

  test('says which numbers exist when there is no ticket with that number', async () => {
    const h = harness();

    await h.run(subcommand('close', [integerOption('number', 7)]), { channelId: PANEL_CHANNEL });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('/ticket list');
  });
});

describe('a close that died between the row and the channel', () => {
  const panels = [{ ...PANEL, transcriptChannelId: TRANSCRIPTS }];

  async function stranded() {
    const h = harness();
    await h.press(pressEvent(openButton()), { config: { panels } });

    const ticket = await h.store.byChannel(GUILD, CREATED);
    if (!ticket) throw new Error('expected an open ticket');

    // The crash: the status transition commits and the process dies before the transcript, the
    // closing message and the delete ever run.
    await h.store.close({ guildId: GUILD, ticketId: ticket.id, closedBy: MEMBER, reason: null });
    h.rest.calls.length = 0;

    return { h, number: ticket.number };
  }

  test('closing by number finishes the transcript, the closing message and the delete', async () => {
    const { h, number } = await stranded();

    await h.run(subcommand('close', [integerOption('number', number)]), {
      channelId: PANEL_CHANNEL,
      config: { panels },
    });

    expect(
      h.discordCalls().filter((call) => call.path === `/channels/${TRANSCRIPTS}/messages`),
    ).toHaveLength(1);
    expect(
      h.discordCalls().filter((call) => call.path === `/channels/${CREATED}/messages`),
    ).toHaveLength(1);
    expect(
      h.discordCalls().filter((call) => call.method === 'DELETE' && call.path.endsWith(CREATED)),
    ).toHaveLength(1);
  });

  test('a second attempt posts nothing twice, however it was invoked', async () => {
    const { h, number } = await stranded();

    await h.run(subcommand('close', [integerOption('number', number)]), {
      channelId: PANEL_CHANNEL,
      config: { panels },
    });
    await h.run(subcommand('close', [integerOption('number', number)]), {
      channelId: PANEL_CHANNEL,
      config: { panels },
    });

    expect(
      h.discordCalls().filter((call) => call.path === `/channels/${CREATED}/messages`),
    ).toHaveLength(1);
    expect(
      h.discordCalls().filter((call) => call.path === `/channels/${TRANSCRIPTS}/messages`),
    ).toHaveLength(1);
    expect(h.discordCalls().filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('tells the moderator it finished an unfinished close rather than claiming a fresh one', async () => {
    const { h, number } = await stranded();

    await h.run(subcommand('close', [integerOption('number', number)]), {
      channelId: PANEL_CHANNEL,
      config: { panels },
    });

    expect(h.replyContent()).toContain('already');
  });
});

describe('/ticket add and remove', () => {
  async function opened() {
    const h = harness();
    await h.press(pressEvent(openButton()));
    h.rest.calls.length = 0;
    return h;
  }

  test('adding somebody rewrites the overwrites with them in it', async () => {
    const h = await opened();

    await h.run(subcommand('add', [userOption('user', HELPER)]), { channelId: CREATED });

    const patch = h.discordCalls().find((call) => call.method === 'PATCH');
    const overwrites =
      (patch?.body as { permission_overwrites: Array<{ id: string }> } | undefined)
        ?.permission_overwrites ?? [];

    expect(overwrites.some((entry) => entry.id === HELPER)).toBe(true);
    expect(overwrites.some((entry) => entry.id === GUILD)).toBe(true);
  });

  test('removing somebody takes them out again', async () => {
    const h = await opened();

    await h.run(subcommand('remove', [userOption('user', HELPER)]), { channelId: CREATED });

    const patch = h.discordCalls().find((call) => call.method === 'PATCH');
    const overwrites =
      (patch?.body as { permission_overwrites: Array<{ id: string }> } | undefined)
        ?.permission_overwrites ?? [];

    expect(overwrites.some((entry) => entry.id === HELPER)).toBe(false);
  });

  test('refuses to remove the member who opened it, and says what to do instead', async () => {
    const h = await opened();

    await h.run(subcommand('remove', [userOption('user', MEMBER)]), { channelId: CREATED });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('/ticket close');
  });
});

describe('/ticket panel', () => {
  test('posts the panel with its button into the configured channel', async () => {
    const h = harness();

    await h.run(subcommand('panel', [stringOption('panel', PANEL.id)]));

    const post = h
      .discordCalls()
      .find((call) => call.path === `/channels/${PANEL_CHANNEL}/messages`);
    expect((post?.body as { components: unknown[] } | undefined)?.components).toHaveLength(1);
  });

  test('names the panels that do exist when the id is wrong', async () => {
    const h = harness();

    await h.run(subcommand('panel', [stringOption('panel', 'nope')]));

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain(PANEL.id);
  });

  test('points an admin at the dashboard when nothing is configured yet', async () => {
    const h = harness();

    await h.run(subcommand('panel', [stringOption('panel', 'x')]), { config: { panels: [] } });

    expect(h.replyContent()).toContain('dashboard');
  });
});

describe('activity tracking', () => {
  test('does not touch the database at all when no panel closes automatically', async () => {
    const h = harness();
    const store = h.store;
    let touched = 0;
    const spy = {
      ...store,
      touch: async () => {
        touched += 1;
      },
    };

    await handleActivity(messageEvent(TICKET_CHANNEL), h.context(), { store: spy as never });

    expect(touched).toBe(0);
  });

  test('bumps the ticket when a panel does close automatically', async () => {
    const h = harness();
    const panels = [{ ...PANEL, autoCloseAfter: '48h' }];

    await h.press(pressEvent(openButton()), { config: { panels } });

    const before = (await h.store.byChannel(GUILD, CREATED))?.lastActivityAt;
    await handleActivity(
      messageEvent(CREATED),
      h.context({ config: { panels } }),
      { store: h.store, applicationId: BOT },
      new Date(Date.now() + 10 * 60_000),
    );

    expect((await h.store.byChannel(GUILD, CREATED))?.lastActivityAt.getTime()).toBeGreaterThan(
      (before ?? new Date()).getTime() - 1,
    );
  });

  test('ignores the bot’s own messages', async () => {
    const h = harness();
    const panels = [{ ...PANEL, autoCloseAfter: '48h' }];
    await h.press(pressEvent(openButton()), { config: { panels } });

    let touched = 0;
    const spy = {
      ...h.store,
      touch: async () => {
        touched += 1;
      },
    };

    await handleActivity(messageEvent(CREATED, true), h.context({ config: { panels } }), {
      store: spy as never,
    });

    expect(touched).toBe(0);
  });
});
