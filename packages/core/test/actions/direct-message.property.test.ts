import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { DedupeStore } from '../../src/actions/dedupe.ts';
import { DefaultActionExecutor } from '../../src/actions/executor.ts';
import { requiredPermissionsFor } from '../../src/actions/kinds.ts';
import { runPrechecks } from '../../src/actions/prechecks.ts';
import {
  type ResolveContextHints,
  type ResolveContextResult,
  resolvePrecheckContext,
} from '../../src/actions/resolve-context.ts';
import type { RestRequestOptions, RestResponse } from '../../src/actions/rest-client.ts';
import { toRestCall } from '../../src/actions/rest-mapping.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type { GuildState, GuildStateStore } from '../../src/guild-state/types.ts';
import { has, Permissions } from '../../src/permissions/bits.ts';
import { computeChannelPermissions, type Overwrite } from '../../src/permissions/compute.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const BOT_ROLE = '410000000000000005';
const CHANNEL = '500000000000000001';
const CATEGORY = '500000000000000002';
const UNCACHED = '500000000000000003';
const INVOKED_IN = '500000000000000004';
const DM = '600000000000000001';
const RECIPIENT = '100000000000000001';

const MAY_POST = Permissions.ViewChannel | Permissions.SendMessages;

const bits = fc.bigInt({ min: 0n, max: (1n << 53n) - 1n });
const rarely = fc.integer({ min: 0, max: 9 }).map((n) => n === 0);
const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n - 1n }).map(String);

const pair = fc.option(fc.record({ allow: bits, deny: bits }), { nil: undefined });

const overwrites = fc
  .record({ everyone: pair, role: pair, member: pair })
  .map(({ everyone, role, member }) => {
    const list: Overwrite[] = [];
    if (everyone) list.push({ id: GUILD, type: 0, ...everyone });
    if (role) list.push({ id: BOT_ROLE, type: 0, ...role });
    if (member) list.push({ id: BOT, type: 1, ...member });
    return list;
  });

const server = fc.record({
  everyone: bits,
  bot: bits,
  administrator: rarely,
  botPosition: fc.integer({ min: 0, max: 20 }),
  channelOverwrites: overwrites,
  categoryOverwrites: overwrites,
  inCategory: fc.boolean(),
});

type Server = {
  everyone: bigint;
  bot: bigint;
  administrator: boolean;
  botPosition: number;
  channelOverwrites: Overwrite[];
  categoryOverwrites: Overwrite[];
  inCategory: boolean;
};

const FILE = { filename: 'transcript.txt', contentType: 'text/plain', data: new Uint8Array([1]) };

const message = fc.record({
  content: fc.string({ minLength: 1, maxLength: 80 }),
  embeds: fc.option(fc.constant([{ title: 'Rules' }]), { nil: undefined }),
  files: fc.option(fc.constant([FILE]), { nil: undefined }),
  poll: fc.option(
    fc.constant({ question: { text: 'Which map?' }, answers: [{ poll_media: { text: 'Dust' } }] }),
    { nil: undefined },
  ),
  replyToMessageId: fc.option(snowflake, { nil: undefined }),
});

function botBits(s: Server): bigint {
  return (s.bot & ~Permissions.Administrator) | (s.administrator ? Permissions.Administrator : 0n);
}

function everyoneBits(s: Server): bigint {
  return s.everyone & ~Permissions.Administrator;
}

function guildState(s: Server): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: everyoneBits(s), position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botBits(s), position: s.botPosition }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [
        CHANNEL,
        {
          id: CHANNEL,
          parentId: s.inCategory ? CATEGORY : null,
          type: 0,
          overwrites: s.channelOverwrites,
        },
      ],
      [CATEGORY, { id: CATEGORY, parentId: null, type: 4, overwrites: s.categoryOverwrites }],
    ]),
    updatedAt: Date.now(),
  };
}

function store(state: GuildState | null): GuildStateStore {
  return {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

function send(payload: Record<string, unknown>): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'tickets',
    kind: 'send',
    actorId: 'tickets',
    targetId: RECIPIENT,
    dryRun: false,
    idempotencyKey: 'tickets:rating:1',
    record: false,
    payload,
  };
}

async function resolve(
  state: GuildState | null,
  request: ActionRequest,
  hints: ResolveContextHints = {},
): Promise<{ result: ResolveContextResult; lookups: number }> {
  let lookups = 0;
  const result = await resolvePrecheckContext(
    {
      store: store(state),
      botUserId: BOT,
      fetchMemberRoles: async () => {
        lookups += 1;
        return [];
      },
    },
    request,
    hints,
  );
  return { result, lookups };
}

function refusal(result: ResolveContextResult): { code: string; humanReason: string } | null {
  return 'failure' in result ? result.failure : runPrechecks(result.context);
}

function channelBits(s: Server, cached: boolean): bigint {
  return computeChannelPermissions(
    {
      guildOwnerId: OWNER,
      everyoneRoleId: GUILD,
      memberId: BOT,
      memberRoleIds: [BOT_ROLE],
      roles: guildState(s).roles,
    },
    cached ? s.channelOverwrites : [],
    cached && s.inCategory ? s.categoryOverwrites : [],
  );
}

const hinting = fc.record({
  appPermissions: fc.option(bits, { nil: undefined }),
  typedIn: fc.constantFrom<'destination' | 'elsewhere' | 'nowhere'>(
    'destination',
    'elsewhere',
    'nowhere',
  ),
});

function hintsFor(
  h: { appPermissions: bigint | undefined; typedIn: 'destination' | 'elsewhere' | 'nowhere' },
  destination: string,
): ResolveContextHints {
  if (h.typedIn === 'nowhere') return {};
  return {
    channelId: h.typedIn === 'destination' ? destination : INVOKED_IN,
    appPermissions: h.appPermissions,
  };
}

function memoryDedupe(): DedupeStore {
  const claimed = new Set<string>();
  return {
    claim: async (key) => {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    release: async (key) => {
      claimed.delete(key);
    },
    has: async (key) => claimed.has(key),
  };
}

const DELIVERED: RestResponse = { status: 200, body: { id: '700000000000000001', channel_id: DM } };

function executorOver(
  state: GuildState | null,
  calls: RestRequestOptions[],
  answer: RestResponse = DELIVERED,
) {
  return new DefaultActionExecutor({
    dedupe: memoryDedupe(),
    rest: {
      request: async (options): Promise<RestResponse> => {
        calls.push(options);
        return answer;
      },
    },
    recorder: { record: async () => ({ caseId: 'case' }) },
    resolveContext: async (request, hints) => {
      const resolved = await resolvePrecheckContext(
        { store: store(state), botUserId: BOT },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });
}

describe('a send to a server channel', () => {
  test('is judged exactly as before unless it is marked as a direct message and Proton has not seen the channel', async () => {
    await fc.assert(
      fc.asyncProperty(server, message, fc.boolean(), hinting, async (s, m, cached, h) => {
        const destination = cached ? CHANNEL : UNCACHED;
        const hints = hintsFor(h, destination);
        const state = guildState(s);
        const base = { channelId: destination, ...m };

        const marks = cached ? [undefined, false, true] : [undefined, false];
        const judged = await Promise.all(
          marks.map((mark) =>
            resolve(
              state,
              send(mark === undefined ? base : { ...base, directMessage: mark }),
              hints,
            ),
          ),
        );

        const [first] = judged;
        if (!first || !('context' in first.result)) return false;
        if (!judged.every((j) => Bun.deepEquals(j.result, first.result) && j.lookups === 0)) {
          return false;
        }

        const context = first.result.context;
        const hinted = hints.channelId === destination ? hints.appPermissions : undefined;
        const permissions = hinted ?? channelBits(s, cached);
        const required =
          MAY_POST |
          (m.embeds ? Permissions.EmbedLinks : 0n) |
          (m.files ? Permissions.AttachFiles : 0n) |
          (m.poll ? Permissions.SendPolls : 0n) |
          (m.replyToMessageId ? Permissions.ReadMessageHistory : 0n);
        const failure = runPrechecks(context);

        return (
          context.channelId === destination &&
          context.requiredPermissions === required &&
          requiredPermissionsFor('send', base) === required &&
          context.botChannelPermissions === permissions &&
          context.channelOverwritesUnknown ===
            (!cached && hinted === undefined ? true : undefined) &&
          (failure?.code ?? null) === (has(permissions, required) ? null : 'missing_permission') &&
          (failure === null || failure.humanReason.includes(`<#${destination}>`))
        );
      }),
      { numRuns: 500 },
    );
  });

  test('is still refused without guild state unless it is marked as a direct message', async () => {
    await fc.assert(
      fc.asyncProperty(
        message,
        fc.constantFrom<boolean | undefined>(undefined, false, true),
        async (m, mark) => {
          const payload = { channelId: CHANNEL, ...m };
          const marked = mark === undefined ? payload : { ...payload, directMessage: mark };
          const { result } = await resolve(null, send(marked));

          return mark === true
            ? refusal(result) === null
            : refusal(result)?.code === 'guild_state_unavailable';
        },
      ),
      { numRuns: 200 },
    );
  });

  test('that Proton has not seen, marked as a direct message by mistake, skips every precheck and is left to Discord’s 403', async () => {
    const state = guildState({
      everyone: 0n,
      bot: 0n,
      administrator: false,
      botPosition: 5,
      channelOverwrites: [],
      categoryOverwrites: [],
      inCategory: false,
    });
    const refused: RestResponse = {
      status: 403,
      body: { message: 'Missing Permissions', code: 50013 },
    };
    const calls: RestRequestOptions[] = [];
    const executor = executorOver(state, calls, refused);
    const marked = send({
      channelId: UNCACHED,
      content: 'Your ticket was closed.',
      directMessage: true,
    });

    expect(await executor.precheck(marked)).toBeNull();

    const sent = await executor.execute(marked);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /channels/${UNCACHED}/messages`,
    ]);
    expect(sent.status).toBe('failed_api');
    expect(sent.failure?.code).toBe('discord_403');
    expect(sent.failure?.discordCode).toBe(50013);

    const unmarkedCalls: RestRequestOptions[] = [];
    const unmarked = await executorOver(state, unmarkedCalls, refused).execute(
      send({ channelId: UNCACHED, content: 'Your ticket was closed.' }),
    );
    expect(unmarked.status).toBe('failed_precheck');
    expect(unmarked.failure?.code).toBe('missing_permission');
    expect(unmarked.failure?.humanReason).toContain(`<#${UNCACHED}>`);
    expect(unmarkedCalls).toEqual([]);
  });
});

describe('a send marked as a direct message', () => {
  test('is judged by nothing in the server: no permission, no channel, no member, no state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(server, { nil: null }), message, hinting, async (s, m, h) => {
        const state = s ? guildState(s) : null;
        const { result, lookups } = await resolve(
          state,
          send({ channelId: DM, ...m, directMessage: true }),
          hintsFor(h, DM),
        );
        if (!('context' in result)) return false;

        const context = result.context;
        return (
          lookups === 0 &&
          runPrechecks(context) === null &&
          context.requiredPermissions === 0n &&
          context.channelId === undefined &&
          context.channelOverwritesUnknown === undefined &&
          context.target === undefined &&
          context.role === undefined &&
          context.guildOwnerId === (state ? OWNER : '')
        );
      }),
      { numRuns: 400 },
    );
  });

  test('reaches Discord from a server that denies Proton every permission, with no mark in the body', async () => {
    await fc.assert(
      fc.asyncProperty(
        server.map((s) => ({ ...s, administrator: false })),
        message,
        async (s, m) => {
          const state = guildState({ ...s, everyone: 0n, bot: 0n });
          const calls: RestRequestOptions[] = [];
          const executor = executorOver(state, calls);

          const dm = send({ channelId: DM, ...m, directMessage: true });
          const checked = await executor.precheck(dm);
          const sent = await executor.execute(dm);

          const unmarked = await executorOver(state, []).execute(
            send({ channelId: DM, ...m, directMessage: undefined }),
          );

          const [call] = calls;
          return (
            checked === null &&
            sent.status === 'executed' &&
            calls.length === 1 &&
            call?.method === 'POST' &&
            call.path === `/channels/${DM}/messages` &&
            !JSON.stringify(call.body ?? {}).includes('directMessage') &&
            unmarked.status === 'failed_precheck' &&
            unmarked.failure?.code === 'missing_permission'
          );
        },
      ),
      { numRuns: 150 },
    );
  });
});

function openDm(): ActionRequest {
  return {
    ...send({ userId: RECIPIENT }),
    kind: 'create_dm',
    idempotencyKey: 'tickets:rating:dm:1',
  };
}

describe('opening a direct message', () => {
  test('is judged by nothing in the server, with or without its state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(server, { nil: null }), hinting, async (s, h) => {
        const state = s ? guildState(s) : null;
        const { result, lookups } = await resolve(state, openDm(), hintsFor(h, CHANNEL));
        if (!('context' in result)) return false;

        const context = result.context;
        return (
          lookups === 0 &&
          runPrechecks(context) === null &&
          context.requiredPermissions === 0n &&
          context.channelId === undefined &&
          context.target === undefined &&
          context.role === undefined
        );
      }),
      { numRuns: 300 },
    );
  });

  test('and the marked send into it both reach Discord before Proton has this server’s state', async () => {
    const calls: RestRequestOptions[] = [];
    const executor = executorOver(null, calls);

    const opened = await executor.execute(openDm());
    const sent = await executor.execute(
      send({ channelId: DM, content: 'How did we do?', directMessage: true }),
    );
    const unmarked = await executorOver(null, []).execute(
      send({ channelId: DM, content: 'How did we do?' }),
    );

    expect(opened.status).toBe('executed');
    expect(sent.status).toBe('executed');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /users/@me/channels',
      `POST /channels/${DM}/messages`,
    ]);
    expect(unmarked.failure?.code).toBe('guild_state_unavailable');
  });
});

describe('the mark', () => {
  test('is never part of what Discord is sent', () => {
    fc.assert(
      fc.property(message, fc.boolean(), (m, mark) => {
        const plain = toRestCall(send({ channelId: DM, ...m }));
        const marked = toRestCall(send({ channelId: DM, ...m, directMessage: mark }));
        return 'call' in plain && 'call' in marked && Bun.deepEquals(plain.call, marked.call);
      }),
      { numRuns: 200 },
    );
  });

  test.each(['edit_message', 'delete_message', 'add_reaction', 'pin_message'] as const)(
    'means nothing to %s, which is still judged in the channel',
    async (kind) => {
      const s: Server = {
        everyone: 0n,
        bot: 0n,
        administrator: false,
        botPosition: 5,
        channelOverwrites: [],
        categoryOverwrites: [],
        inCategory: false,
      };

      const { result } = await resolve(guildState(s), {
        ...send({
          channelId: DM,
          messageId: '700000000000000001',
          emoji: '👍',
          content: 'edited',
          directMessage: true,
        }),
        kind,
      });

      expect(refusal(result)?.code).toBe('missing_permission');
    },
  );
});
