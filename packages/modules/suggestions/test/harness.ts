import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type EntitlementTier,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  OptionType,
  type Overwrite,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { suggestionsCommands } from '../src/commands.ts';
import { type SuggestionsConfig, suggestionsDefaultConfig } from '../src/config.ts';
import type { SuggestionStatus } from '../src/decide.ts';
import type { SuggestionsDeps } from '../src/deps.ts';
import type { Tally } from '../src/embed.ts';
import { handleVote } from '../src/interactions.ts';
import type {
  AttachInput,
  CreateSuggestionInput,
  DecideSuggestionInput,
  Suggestion,
  SuggestionStore,
  VoteOutcome,
  VoteValue,
} from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const APPLICATION = '300000000000000009';
export const MEMBER = '100000000000000001';
export const OTHER = '100000000000000002';
export const STAFF = '100000000000000003';
export const CHANNEL = '500000000000000001';
export const SUGGESTION_CHANNEL = '500000000000000002';
export const INTERACTION = '600000000000000001';
export const MESSAGE = '700000000000000001';
export const THREAD = '700000000000000002';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.EmbedLinks |
  Permissions.CreatePublicThreads;

function guildState(suggestionOverwrites: Overwrite[]): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: BOT_PERMISSIONS, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }],
      [
        SUGGESTION_CHANNEL,
        { id: SUGGESTION_CHANNEL, parentId: null, overwrites: suggestionOverwrites },
      ],
    ]),
    updatedAt: Date.now(),
  };
}

export function denyInSuggestionChannel(permissions: bigint): Overwrite[] {
  return [{ id: BOT_ROLE, type: 0, allow: 0n, deny: permissions }];
}

export class MemorySuggestionStore implements SuggestionStore {
  readonly rows = new Map<string, Suggestion>();
  readonly votes = new Map<string, Map<string, VoteValue>>();

  async create(input: CreateSuggestionInput): Promise<Suggestion> {
    const taken = [...this.rows.values()]
      .filter((row) => row.guildId === input.guildId)
      .map((row) => row.number);

    const suggestion: Suggestion = {
      id: input.id,
      guildId: input.guildId,
      number: Math.max(0, ...taken) + 1,
      channelId: input.channelId,
      messageId: null,
      threadId: null,
      authorId: input.authorId,
      content: input.content,
      status: 'open',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      createdAt: new Date(),
    };

    this.rows.set(suggestion.id, suggestion);
    return { ...suggestion };
  }

  async get(guildId: string, suggestionId: string): Promise<Suggestion | null> {
    const row = this.rows.get(suggestionId);
    return row && row.guildId === guildId ? { ...row } : null;
  }

  async byNumber(guildId: string, number: number): Promise<Suggestion | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.guildId === guildId && candidate.number === number,
    );
    return row ? { ...row } : null;
  }

  async attach(
    guildId: string,
    suggestionId: string,
    ids: AttachInput,
  ): Promise<Suggestion | null> {
    const row = this.rows.get(suggestionId);
    if (!row || row.guildId !== guildId) return null;

    const next: Suggestion = {
      ...row,
      ...(ids.messageId === undefined ? {} : { messageId: ids.messageId }),
      ...(ids.threadId === undefined ? {} : { threadId: ids.threadId }),
    };

    this.rows.set(suggestionId, next);
    return { ...next };
  }

  async remove(guildId: string, suggestionId: string): Promise<boolean> {
    const row = this.rows.get(suggestionId);
    if (!row || row.guildId !== guildId) return false;

    this.rows.delete(suggestionId);
    this.votes.delete(suggestionId);
    return true;
  }

  async decide(input: DecideSuggestionInput): Promise<Suggestion | null> {
    const row = this.rows.get(input.suggestionId);
    if (!row || row.guildId !== input.guildId) return null;

    const next: Suggestion = {
      ...row,
      status: input.status,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
      decisionReason: input.reason,
    };

    this.rows.set(input.suggestionId, next);
    return { ...next };
  }

  async vote(suggestionId: string, userId: string, vote: VoteValue): Promise<VoteOutcome> {
    const cast = this.votes.get(suggestionId) ?? new Map<string, VoteValue>();
    this.votes.set(suggestionId, cast);

    if (cast.get(userId) === vote) return 'unchanged';

    cast.set(userId, vote);
    return 'recorded';
  }

  async tally(suggestionId: string): Promise<Tally> {
    const cast = [...(this.votes.get(suggestionId)?.values() ?? [])];

    return {
      up: cast.filter((value) => value === 1).length,
      down: cast.filter((value) => value === -1).length,
    };
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

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    return {
      status: 200,
      body: { id: options.path.endsWith('/threads') ? THREAD : MESSAGE },
    };
  }
}

export interface RunOverrides {
  config: Partial<SuggestionsConfig>;
  tier: EntitlementTier;
  deps: SuggestionsDeps;
  idempotencyKey: string;
  appPermissions: bigint;
  userId: string;
}

export interface CallBody {
  type?: number;
  content?: string;
  embeds?: EmbedBody[];
  components?: Array<{ type: number; components?: Array<Record<string, unknown>> }>;
  allowed_mentions?: { parse?: string[]; users?: string[] };
  data?: {
    content?: string;
    embeds?: EmbedBody[];
    components?: Array<{ type: number; components?: Array<Record<string, unknown>> }>;
    flags?: number;
  };
}

export interface EmbedBody {
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface Harness {
  rest: FakeRest;
  store: MemorySuggestionStore;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  interactionBodies(): CallBody[];
  followUpBodies(): CallBody[];
  sendBodies(): CallBody[];
  editBodies(): CallBody[];
  threadBodies(): Array<Record<string, unknown>>;

  replyContent(): string | null;
  followUpContent(): string | null;
  postedEmbed(): EmbedBody | null;
  editedEmbed(): EmbedBody | null;
  buttons(): Array<Record<string, unknown>>;

  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  press(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
}

export interface HarnessOptions {
  applicationId?: string;

  suggestionChannelOverwrites?: Overwrite[];
}

export function harness(options: HarnessOptions = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: Array<{ level: string; message: string }> = [];
  const store = new MemorySuggestionStore();

  const stateStore: GuildStateStore = {
    get: async () => guildState(options.suggestionChannelOverwrites ?? []),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const executor = new DefaultActionExecutor({
    dedupe,
    rest,
    recorder,
    resolveContext: async (
      request,
      hints,
    ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
      const resolved = await resolvePrecheckContext(
        { store: stateStore, botUserId: BOT, fetchMemberRoles: async () => [] },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const depsOf = (overrides: Partial<RunOverrides>): SuggestionsDeps =>
    overrides.deps ?? { store, applicationId: options.applicationId ?? APPLICATION };

  const bodiesFor = (predicate: (call: RestRequestOptions) => boolean): CallBody[] =>
    rest.calls.filter(predicate).map((call) => call.body as CallBody);

  const interactionBodies = (): CallBody[] =>
    bodiesFor((call) => call.path.startsWith('/interactions/'));
  const followUpBodies = (): CallBody[] => bodiesFor((call) => call.path.startsWith('/webhooks/'));
  const sendBodies = (): CallBody[] =>
    bodiesFor((call) => call.method === 'POST' && call.path.endsWith('/messages'));
  const editBodies = (): CallBody[] =>
    bodiesFor((call) => call.method === 'PATCH' && call.path.includes('/messages/'));

  const moduleContext = (overrides: Partial<RunOverrides>): ModuleContext<SuggestionsConfig> => ({
    guildId: GUILD,
    config: {
      ...suggestionsDefaultConfig,
      enabled: true,
      channelId: SUGGESTION_CHANNEL,
      ...overrides.config,
    },
    tier: overrides.tier ?? 'free',
    executor: executor.scoped({
      channelId: CHANNEL,
      appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
    }),
    logger,
  });

  return {
    rest,
    store,
    recorder,
    logs,

    calls: () => rest.calls,
    interactionBodies,
    followUpBodies,
    sendBodies,
    editBodies,

    threadBodies: () =>
      rest.calls
        .filter((call) => call.path.endsWith('/threads'))
        .map((call) => call.body as Record<string, unknown>),

    replyContent: () =>
      interactionBodies()
        .map((body) => body.data?.content)
        .findLast((text) => text !== undefined) ?? null,

    followUpContent: () =>
      followUpBodies()
        .map((body) => body.content)
        .findLast((text) => text !== undefined) ?? null,

    postedEmbed: () => sendBodies().at(-1)?.embeds?.[0] ?? null,
    editedEmbed: () => editBodies().at(-1)?.embeds?.[0] ?? null,

    buttons: () => {
      const body = editBodies().at(-1) ?? sendBodies().at(-1);
      return (body?.components?.[0]?.components ?? []) as Array<Record<string, unknown>>;
    },

    async run(command, commandOptions, overrides = {}) {
      const definition = suggestionsCommands(depsOf(overrides)).find((c) => c.name === command);
      if (!definition) throw new Error(`no such suggestions command: ${command}`);

      const ctx: CommandContext<SuggestionsConfig> = {
        ...moduleContext(overrides),
        channelId: CHANNEL,
        userId: overrides.userId ?? MEMBER,
        options: createCommandOptions(commandOptions),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
      };

      await definition.handler(ctx);
    },

    async press(event, overrides = {}) {
      await handleVote(event, moduleContext(overrides), depsOf(overrides));
    },
  };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}

export function subcommand(name: string, options: RawOption[]): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export interface PressOptions {
  userId?: string;
}

export function voteEvent(customId: string, options: PressOptions = {}): ProtonEvent {
  return {
    id: newId(),
    type: 'interaction.component',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: APPLICATION,
      type: 3,
      token: 'interaction-token',
      guild_id: GUILD,
      channel_id: SUGGESTION_CHANNEL,
      member: { user: { id: options.userId ?? MEMBER }, roles: [] },
      message: { id: MESSAGE },
      data: { custom_id: customId, component_type: 2 },
    },
  };
}

export function voteId(suggestionId: string, direction: 'up' | 'down'): string {
  return `proton:suggestions:vote:${suggestionId}:${direction}`;
}

export async function seed(
  h: Harness,
  overrides: Partial<Suggestion> & { id?: string } = {},
): Promise<Suggestion> {
  const created = await h.store.create({
    id: overrides.id ?? newId(),
    guildId: GUILD,
    channelId: overrides.channelId ?? SUGGESTION_CHANNEL,
    authorId: overrides.authorId ?? MEMBER,
    content: overrides.content ?? 'Add a bot-commands channel.',
  });

  const row: Suggestion = {
    ...created,
    messageId: overrides.messageId === undefined ? MESSAGE : overrides.messageId,
    ...(overrides.status ? { status: overrides.status as SuggestionStatus } : {}),
    ...(overrides.decidedBy === undefined ? {} : { decidedBy: overrides.decidedBy }),
    ...(overrides.decidedAt === undefined ? {} : { decidedAt: overrides.decidedAt }),
    ...(overrides.decisionReason === undefined ? {} : { decisionReason: overrides.decisionReason }),
  };

  h.store.rows.set(row.id, row);
  return row;
}
