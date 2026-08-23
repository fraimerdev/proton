import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  OptionType,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
  type ScheduleOutcome,
} from '@proton/core';
import { ticketsCommands } from '../src/commands.ts';
import { type TicketPanel, type TicketsConfig, ticketsDefaultConfig } from '../src/config.ts';
import type { TicketsDeps } from '../src/deps.ts';
import { createTicketInteractionListener } from '../src/interactions.ts';
import type { CloseTicketInput, ReserveTicketInput, Ticket, TicketStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '100000000000000001';
export const HELPER = '100000000000000002';
export const SUPPORT_ROLE = '410000000000000007';
export const PANEL_CHANNEL = '500000000000000001';
export const CATEGORY = '500000000000000009';
export const TICKET_CHANNEL = '500000000000000002';
export const CREATED = '500000000000000003';
export const TRANSCRIPTS = '500000000000000004';
export const INTERACTION = '600000000000000001';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

// Includes everything TICKET_MEMBER_ALLOW hands out: Discord refuses an overwrite granting a
// permission the bot does not itself hold, and the precheck now says so before the call.
export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.ReadMessageHistory |
  Permissions.AttachFiles |
  Permissions.EmbedLinks |
  Permissions.ManageChannels |
  Permissions.ManageRoles;

export const PANEL: TicketPanel = {
  id: 'support',
  name: 'Support',
  channelId: PANEL_CHANNEL,
  categoryId: CATEGORY,
  buttonLabel: 'Open a ticket',
  panelText: 'Need a hand?',
  openingMessage: '{user} opened a ticket.',
  supportRoleIds: [SUPPORT_ROLE],
};

function guildState(botPermissions: bigint): GuildState {
  const channels = new Map(
    [PANEL_CHANNEL, TICKET_CHANNEL, CREATED, TRANSCRIPTS, CATEGORY].map((id) => [
      id,
      { id, parentId: null, overwrites: [] },
    ]),
  );

  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
      [SUPPORT_ROLE, { id: SUPPORT_ROLE, permissions: 0n, position: 2 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels,
    updatedAt: Date.now(),
  };
}

export class MemoryTicketStore implements TicketStore {
  readonly rows = new Map<string, Ticket>();
  #next = 0;

  async reserve(input: ReserveTicketInput): Promise<Ticket> {
    const id = newId();
    this.#next += 1;

    const ticket: Ticket = {
      id,
      guildId: input.guildId,
      number: this.#next,
      panelId: input.panelId,
      channelId: id,
      openerId: input.openerId,
      status: 'open',
      openedAt: new Date(),
      lastActivityAt: new Date(),
      closedAt: null,
      closedBy: null,
      closeReason: null,
    };

    this.rows.set(id, ticket);
    return ticket;
  }

  async attach(_guildId: string, ticketId: string, channelId: string): Promise<Ticket | null> {
    const ticket = this.rows.get(ticketId);
    if (!ticket) return null;

    const next = { ...ticket, channelId };
    this.rows.set(ticketId, next);
    return next;
  }

  async abandon(_guildId: string, ticketId: string): Promise<void> {
    this.rows.delete(ticketId);
  }

  async get(guildId: string, ticketId: string): Promise<Ticket | null> {
    const ticket = this.rows.get(ticketId);
    return ticket && ticket.guildId === guildId ? ticket : null;
  }

  async byChannel(guildId: string, channelId: string): Promise<Ticket | null> {
    return (
      [...this.rows.values()].find(
        (ticket) =>
          ticket.guildId === guildId && ticket.channelId === channelId && ticket.status === 'open',
      ) ?? null
    );
  }

  async byNumber(guildId: string, number: number): Promise<Ticket | null> {
    return (
      [...this.rows.values()].find(
        (ticket) => ticket.guildId === guildId && ticket.number === number,
      ) ?? null
    );
  }

  async countOpenFor(guildId: string, openerId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (ticket) =>
        ticket.guildId === guildId && ticket.openerId === openerId && ticket.status === 'open',
    ).length;
  }

  async listOpen(guildId: string): Promise<Ticket[]> {
    return [...this.rows.values()]
      .filter((ticket) => ticket.guildId === guildId && ticket.status === 'open')
      .sort((a, b) => a.number - b.number);
  }

  async close(input: CloseTicketInput): Promise<Ticket | null> {
    const ticket = this.rows.get(input.ticketId);
    if (ticket?.status !== 'open') return null;

    const closed: Ticket = {
      ...ticket,
      status: 'closed',
      closedAt: new Date(),
      closedBy: input.closedBy,
      closeReason: input.reason,
    };

    this.rows.set(ticket.id, closed);
    return closed;
  }

  async touch(guildId: string, channelId: string, notBefore: Date): Promise<void> {
    const ticket = await this.byChannel(guildId, channelId);
    if (!ticket || ticket.lastActivityAt >= notBefore) return;

    this.rows.set(ticket.id, { ...ticket, lastActivityAt: new Date() });
  }
}

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  response: RestResponse = { status: 200, body: { id: CREATED } };
  failCreate = false;

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    if (this.failCreate && options.method === 'POST' && options.path.endsWith('/channels')) {
      return { status: 403, body: { message: 'Missing Access' } };
    }

    return this.response;
  }
}

export interface Scheduled {
  jobId: string;
  runAt: Date;
  naturalKey: string;
  data: unknown;
}

export interface RunOverrides {
  config: Partial<TicketsConfig>;
  deps: TicketsDeps;
  botPermissions: bigint;
  channelId: string;
  userId: string;
  tier: 'free' | 'plus' | 'pro';
}

export interface Harness {
  rest: FakeRest;
  store: MemoryTicketStore;
  logs: Array<{ level: string; message: string }>;
  scheduled: Scheduled[];
  cancelled: Array<{ jobId: string; naturalKey: string }>;

  calls(): RestRequestOptions[];
  discordCalls(): RestRequestOptions[];
  replyContent(): string | null;
  followUpContent(): string | null;

  press(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
  run(options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  context(overrides?: Partial<RunOverrides>): ModuleContext<TicketsConfig>;
}

export function harness(): Harness {
  const rest = new FakeRest();
  const store = new MemoryTicketStore();
  const dedupe = new MemoryDedupe();
  const recorder = new MemoryRecorder();
  const logs: Array<{ level: string; message: string }> = [];
  const scheduled: Scheduled[] = [];
  const cancelled: Array<{ jobId: string; naturalKey: string }> = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const executorFor = (botPermissions: bigint) => {
    const state: GuildStateStore = {
      get: async () => guildState(botPermissions),
      put: async () => undefined,
      patch: async () => undefined,
      delete: async () => undefined,
    };

    return new DefaultActionExecutor({
      dedupe,
      rest,
      recorder,
      resolveContext: async (
        request,
        hints,
      ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
        const resolved = await resolvePrecheckContext(
          { store: state, botUserId: BOT, fetchMemberRoles: async () => [] },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    });
  };

  const config = (overrides: Partial<RunOverrides>): TicketsConfig => ({
    ...ticketsDefaultConfig,
    enabled: true,
    panels: [PANEL],
    ...overrides.config,
  });

  const schedule = async (
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
  ): Promise<ScheduleOutcome> => {
    scheduled.push({ jobId, runAt, naturalKey, data });
    return { scheduled: true, replaced: false };
  };

  const cancel = async (jobId: string, naturalKey: string): Promise<void> => {
    cancelled.push({ jobId, naturalKey });
  };

  const bodyOf = (call: RestRequestOptions | undefined): { content?: string } | undefined =>
    (call?.body as { data?: { content?: string } })?.data ?? (call?.body as { content?: string });

  return {
    rest,
    store,
    logs,
    scheduled,
    cancelled,

    calls: () => rest.calls,
    discordCalls: () =>
      rest.calls.filter(
        (call) => !call.path.startsWith('/interactions/') && !call.path.startsWith('/webhooks/'),
      ),

    replyContent: () =>
      bodyOf(rest.calls.find((call) => call.path.startsWith('/interactions/')))?.content ?? null,

    followUpContent: () =>
      bodyOf(rest.calls.find((call) => call.path.startsWith('/webhooks/')))?.content ?? null,

    context(overrides = {}) {
      return {
        guildId: GUILD,
        config: config(overrides),
        tier: overrides.tier ?? 'free',
        executor: executorFor(overrides.botPermissions ?? BOT_PERMISSIONS),
        logger,
        schedule,
        cancel,
      };
    },

    async press(event, overrides = {}) {
      const listener = createTicketInteractionListener(
        overrides.deps ?? { store, applicationId: BOT, botUserId: BOT },
      );

      await listener.handler(event, this.context(overrides));
    },

    async run(options, overrides = {}) {
      const definition = ticketsCommands(
        overrides.deps ?? {
          store,
          applicationId: BOT,
          botUserId: BOT,
          guildState: {
            get: async () => guildState(overrides.botPermissions ?? BOT_PERMISSIONS),
            put: async () => undefined,
            patch: async () => undefined,
            delete: async () => undefined,
          },
        },
      )[0];
      if (!definition) throw new Error('no /ticket command');

      const ctx: CommandContext<TicketsConfig> = {
        guildId: GUILD,
        channelId: overrides.channelId ?? TICKET_CHANNEL,
        userId: overrides.userId ?? MEMBER,
        config: config(overrides),
        tier: overrides.tier ?? 'free',
        executor: executorFor(overrides.botPermissions ?? BOT_PERMISSIONS).scoped({
          channelId: overrides.channelId ?? TICKET_CHANNEL,
          appPermissions: overrides.botPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        schedule,
        cancel,
        options: createCommandOptions(options),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: newId(),
      };

      await definition.handler(ctx);
    },
  };
}

export function pressEvent(customId: string, userId = MEMBER, id?: string): ProtonEvent {
  return {
    id: id ?? newId(),
    type: 'interaction.component',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: BOT,
      type: 3,
      token: 'interaction-token',
      guild_id: GUILD,
      channel_id: PANEL_CHANNEL,
      member: { user: { id: userId }, roles: [] },
      message: { id: '700000000000000001' },
      data: { custom_id: customId, component_type: 2 },
    },
  };
}

export function messageEvent(channelId: string, isBot = false): ProtonEvent {
  return {
    id: newId(),
    type: 'message.created',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: '700000000000000002',
      channel_id: channelId,
      guild_id: GUILD,
      author: { id: MEMBER, bot: isBot },
      content: 'hello',
    },
  };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}
