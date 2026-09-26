import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  DefaultActionExecutor,
  encodeCustomId,
  type GuildState,
  type ModuleContext,
  newId,
  Permissions,
  resolvePrecheckContext,
} from '@proton/core';
import { TEXT_CHANNEL_TYPE, type TicketsConfig, ticketTypeSchema } from '../src/config.ts';
import { closeTicket } from '../src/lifecycle.ts';
import type { Ticket } from '../src/store.ts';
import {
  BOT,
  BOT_PERMISSIONS,
  DM_CHANNEL,
  GUILD,
  HELPER,
  harness,
  MOD,
  OTHER_HELPER,
  OWNER,
  PANEL,
  pressEvent,
  subcommand,
  TYPE,
  userOption,
} from './harness.ts';

const RATED = ticketTypeSchema.parse({ ...TYPE, askRating: true });

function customId(action: string, ...args: string[]): string {
  const encoded = encodeCustomId('tickets', action, ...args);
  if (!encoded.ok) throw new Error(encoded.humanReason);
  return encoded.customId;
}

const OPEN = customId('ot', PANEL.id, TYPE.id);

type Harness = ReturnType<typeof harness>;

function prompts(h: Harness, channelId: string): Array<Record<string, unknown>> {
  return h
    .sentIn(channelId)
    .filter((body) => JSON.stringify(body).includes('How was your support experience'));
}

function dmOpens(h: Harness): void {
  h.rest.fail('/users/@me/channels', { status: 200, body: { id: DM_CHANNEL, type: 1 } });
}

function dmsClosed(h: Harness): void {
  dmOpens(h);
  h.rest.fail(`/channels/${DM_CHANNEL}/messages`, {
    status: 403,
    body: { code: 50007, message: 'Cannot send messages to this user' },
  });
}

async function openRated(h: Harness) {
  await h.press(pressEvent(OPEN));
  return h.ticket();
}

async function closeDirectly(
  h: Harness,
  ticket: Ticket,
  ctx: ModuleContext<TicketsConfig> = h.context(),
) {
  const current = await h.store.get(GUILD, ticket.id);
  if (!current) throw new Error('the ticket row is gone');

  return closeTicket({
    ctx,
    store: h.store,
    deps: h.deps,
    ticket: current,
    closedBy: HELPER,
    reason: null,
    idempotencyKey: newId(),
  });
}

function sendOnlyThroughOverwrite(channelId: string): GuildState {
  const role = '410000000000000099';

  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: Permissions.ViewChannel, position: 0 }],
      [role, { id: role, permissions: BOT_PERMISSIONS & ~Permissions.SendMessages, position: 5 }],
    ]),
    botRoleIds: [role],
    channels: new Map([
      [
        channelId,
        {
          id: channelId,
          parentId: null,
          type: TEXT_CHANNEL_TYPE,
          overwrites: [{ id: BOT, type: 1, allow: Permissions.SendMessages, deny: 0n }],
        },
      ],
    ]),
    updatedAt: Date.now(),
  };
}

function executorOver(h: Harness, state: GuildState | null): ActionExecutor {
  const claimed = new Set<string>();

  return new DefaultActionExecutor({
    dedupe: {
      claim: async (key) => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      release: async (key) => {
        claimed.delete(key);
      },
      has: async (key) => claimed.has(key),
    },
    rest: h.rest,
    recorder: { record: async () => ({ caseId: newId() }) },
    resolveContext: async (request) => {
      const resolved = await resolvePrecheckContext(
        {
          store: {
            get: async () => state,
            put: async () => undefined,
            patch: async () => undefined,
            delete: async () => undefined,
          },
          botUserId: BOT,
        },
        request,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });
}

describe('the rating prompt', () => {
  test('a member who accepts DMs is asked there, and the ticket channel stays quiet', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmOpens(h);

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    const [asked] = prompts(h, DM_CHANNEL);
    expect(prompts(h, DM_CHANNEL)).toHaveLength(1);
    expect(asked?.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(asked)).not.toContain(`<@${ticket.ownerId}>`);
    expect(prompts(h, ticket.channelId)).toHaveLength(0);
  });

  test('a member whose DMs refuse Proton is asked in the ticket channel instead', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmsClosed(h);

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    expect(prompts(h, DM_CHANNEL)).toHaveLength(1);

    const [fallback] = prompts(h, ticket.channelId);
    expect(fallback).toBeDefined();
    expect(JSON.stringify(fallback)).toContain(customId('rate', ticket.id, '5'));
    expect(h.logs.some((entry) => entry.message.includes('without asking for a rating'))).toBe(
      false,
    );
  });

  test('the prompt in the ticket channel names the owner and pings only them', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmsClosed(h);

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    const [fallback] = prompts(h, ticket.channelId);
    expect(JSON.stringify(fallback)).toContain(
      `<@${ticket.ownerId}>, I couldn't DM you, so I'm asking here.`,
    );
    expect(fallback?.allowed_mentions).toEqual({ parse: [], users: [ticket.ownerId] });
  });

  test('a DM Proton could not open is asked in the ticket channel, addressed to the owner', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    h.rest.fail('/users/@me/channels', {
      status: 502,
      body: { error: 'rest_proxy_upstream_failure' },
    });

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    const [asked] = prompts(h, ticket.channelId);
    expect(prompts(h, ticket.channelId)).toHaveLength(1);
    expect(asked?.allowed_mentions).toEqual({ parse: [], users: [ticket.ownerId] });
  });

  test('a server that grants Send Messages only in its channels still has the owner asked by DM', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmOpens(h);

    await closeDirectly(h, ticket, {
      ...h.context(),
      executor: executorOver(h, sendOnlyThroughOverwrite(ticket.channelId)),
    });

    expect(prompts(h, DM_CHANNEL)).toHaveLength(1);
    expect(prompts(h, ticket.channelId)).toHaveLength(0);
  });

  test('the same server still gets the transcript to the owner by DM', async () => {
    const h = harness({
      config: { types: [ticketTypeSchema.parse({ ...TYPE, transcript: 'owner' })] },
    });
    const ticket = await openRated(h);
    dmOpens(h);

    await closeDirectly(h, ticket, {
      ...h.context(),
      executor: executorOver(h, sendOnlyThroughOverwrite(ticket.channelId)),
    });

    const [transcript] = h.sentIn(DM_CHANNEL);
    expect(JSON.stringify(transcript)).toContain(`**Ticket #${ticket.number}**`);
    expect(JSON.stringify(transcript)).not.toContain('directMessage');
    expect(h.sentFiles().some((file) => file.filename.endsWith('.html'))).toBe(true);
  });

  test('before Proton has this server’s state, the owner still gets the prompt and the transcript by DM', async () => {
    const h = harness({
      config: { types: [ticketTypeSchema.parse({ ...RATED, transcript: 'owner' })] },
    });
    const ticket = await openRated(h);
    dmOpens(h);

    await closeDirectly(h, ticket, { ...h.context(), executor: executorOver(h, null) });

    expect(prompts(h, DM_CHANNEL)).toHaveLength(1);
    expect(prompts(h, ticket.channelId)).toHaveLength(0);
    expect(
      h
        .sentIn(DM_CHANNEL)
        .some((body) => JSON.stringify(body).includes(`**Ticket #${ticket.number}**`)),
    ).toBe(true);
  });

  test('a replayed close does not post the fallback prompt a second time', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmsClosed(h);

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    const replay = await closeDirectly(h, ticket);

    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(prompts(h, DM_CHANNEL)).toHaveLength(1);
    expect(prompts(h, ticket.channelId)).toHaveLength(1);
  });

  test('a replayed close retries a DM that failed in transit, and the ticket channel stays quiet', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmOpens(h);
    let down = true;
    h.rest.fail((call) => down && call.path === `/channels/${DM_CHANNEL}/messages`, {
      status: 502,
      body: { error: 'rest_proxy_upstream_failure' },
    });

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });
    down = false;
    const replay = await closeDirectly(h, ticket);

    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(prompts(h, DM_CHANNEL)).toHaveLength(2);
    expect(prompts(h, ticket.channelId)).toHaveLength(0);
  });

  test('only a refusal falls back: a DM that failed in transit is logged, not moved', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmOpens(h);
    h.rest.fail(`/channels/${DM_CHANNEL}/messages`, {
      status: 502,
      body: { error: 'rest_proxy_upstream_failure' },
    });

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    expect(prompts(h, ticket.channelId)).toHaveLength(0);
    expect(
      h.logs.some(
        (entry) => entry.level === 'info' && entry.message.includes('without asking for a rating'),
      ),
    ).toBe(true);
  });

  test('a fallback the ticket channel refuses too is logged, and the ticket still closes', async () => {
    const h = harness({ config: { types: [RATED] } });
    const ticket = await openRated(h);
    dmsClosed(h);
    h.rest.fail(
      (call) =>
        call.path === `/channels/${ticket.channelId}/messages` &&
        JSON.stringify((call as { body?: unknown }).body).includes(
          'How was your support experience',
        ),
      { status: 403, body: { code: 50013, message: 'Missing Permissions' } },
    );

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    expect(prompts(h, ticket.channelId)).toHaveLength(1);
    expect((await h.store.get(GUILD, ticket.id))?.status).toBe('closed');
    expect(h.logs.some((entry) => entry.message.includes('without asking for a rating'))).toBe(
      true,
    );
  });
});

describe('the transcript by DM', () => {
  test('a replayed close retries a DM that failed in transit, and delivers it once', async () => {
    const h = harness({
      config: { types: [ticketTypeSchema.parse({ ...TYPE, transcript: 'owner' })] },
    });
    const ticket = await openRated(h);
    dmOpens(h);
    let down = true;
    h.rest.fail((call) => down && call.path === `/channels/${DM_CHANNEL}/messages`, {
      status: 502,
      body: { error: 'rest_proxy_upstream_failure' },
    });

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });
    down = false;
    await closeDirectly(h, ticket);
    await closeDirectly(h, ticket);

    const attempts = h
      .sentIn(DM_CHANNEL)
      .filter((body) => JSON.stringify(body).includes(`**Ticket #${ticket.number}**`));
    expect(attempts).toHaveLength(2);
    expect(h.logs.some((entry) => entry.message.includes('could not open a DM with them'))).toBe(
      false,
    );
  });
});

describe('removing a participant', () => {
  async function withParticipant(h: Harness) {
    await h.press(pressEvent(OPEN));
    const ticket = h.ticket();

    await h.run(subcommand('add', [userOption('user', OTHER_HELPER)]), {
      ...MOD,
      channelId: ticket.channelId,
    });

    return ticket;
  }

  const revoke = (call: { method: string; path: string }): boolean =>
    call.method === 'DELETE' && call.path.endsWith(`/permissions/${OTHER_HELPER}`);

  test.each([
    ['an overwrite Discord no longer has', { code: 10009, message: 'Unknown Overwrite' }],
    ['a ticket channel Discord no longer has', { code: 10003, message: 'Unknown Channel' }],
  ])('%s counts as access already taken away', async (_name, body) => {
    const h = harness();
    const ticket = await withParticipant(h);
    h.rest.fail(revoke, { status: 404, body });

    await h.run(subcommand('remove', [userOption('user', OTHER_HELPER)]), {
      ...MOD,
      channelId: ticket.channelId,
    });

    expect(h.lastTold()).toContain(`Removed <@${OTHER_HELPER}> from ticket #${ticket.number}.`);
    expect(
      (await h.store.listParticipants(ticket.id)).some((entry) => entry.userId === OTHER_HELPER),
    ).toBe(false);
    expect(h.store.events.some((entry) => entry.type === 'member-removed')).toBe(true);
    expect(h.logs.some((entry) => entry.level === 'error')).toBe(false);
  });

  test.each([
    ['a refused revoke', { status: 403, body: { code: 50013, message: 'Missing Permissions' } }],
    ['a 404 with no Discord code', { status: 404, body: '404 Not Found' }],
    ['the proxy’s own 404', { status: 404, body: { error: 'not_found' } }],
    ['Unknown Guild', { status: 404, body: { code: 10004, message: 'Unknown Guild' } }],
  ])('%s still says the member kept their channel access', async (_name, answer) => {
    const h = harness();
    const ticket = await withParticipant(h);
    h.rest.fail(revoke, answer);

    await h.run(subcommand('remove', [userOption('user', OTHER_HELPER)]), {
      ...MOD,
      channelId: ticket.channelId,
    });

    expect(h.lastTold()).toContain('couldn’t take away their access to the channel');
    expect(h.store.events.some((entry) => entry.type === 'member-removed')).toBe(false);
    expect(
      h.logs.some(
        (entry) => entry.level === 'error' && entry.message.includes('could not be revoked'),
      ),
    ).toBe(true);
  });
});
