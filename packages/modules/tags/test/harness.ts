import {
  type ActionRequest,
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
import { handleAutocomplete } from '../src/autocomplete.ts';
import { tagsCommands } from '../src/commands.ts';
import { type TagsConfig, tagsDefaultConfig } from '../src/config.ts';
import type { TagsDeps } from '../src/deps.ts';
import type { CreateTagInput, ListTagsQuery, ListTagsResult, Tag, TagStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '100000000000000001';
export const CHANNEL = '500000000000000001';
export const INTERACTION = '600000000000000001';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

const BOT_PERMISSIONS = Permissions.ViewChannel | Permissions.SendMessages;

function guildState(): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: BOT_PERMISSIONS, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

export class MemoryTagStore implements TagStore {
  readonly rows = new Map<string, Tag>();

  #key(guildId: string, name: string): string {
    return `${guildId}:${name}`;
  }

  async get(guildId: string, name: string): Promise<Tag | null> {
    return this.rows.get(this.#key(guildId, name)) ?? null;
  }

  async recall(guildId: string, name: string): Promise<Tag | null> {
    const tag = this.rows.get(this.#key(guildId, name));
    if (!tag) return null;

    const next: Tag = { ...tag, uses: tag.uses + 1 };
    this.rows.set(this.#key(guildId, name), next);
    return next;
  }

  async create(input: CreateTagInput): Promise<'created' | 'exists'> {
    const key = this.#key(input.guildId, input.name);
    if (this.rows.has(key)) return 'exists';

    const now = new Date();
    this.rows.set(key, {
      guildId: input.guildId,
      name: input.name,
      content: input.content,
      createdBy: input.createdBy,
      updatedBy: null,
      uses: 0,
      createdAt: now,
      updatedAt: now,
    });
    return 'created';
  }

  async update(guildId: string, name: string, content: string, editedBy: string): Promise<boolean> {
    const key = this.#key(guildId, name);
    const tag = this.rows.get(key);
    if (!tag) return false;

    this.rows.set(key, { ...tag, content, updatedBy: editedBy, updatedAt: new Date() });
    return true;
  }

  async remove(guildId: string, name: string): Promise<boolean> {
    return this.rows.delete(this.#key(guildId, name));
  }

  async list(query: ListTagsQuery): Promise<ListTagsResult> {
    const all = [...this.rows.values()]
      .filter((tag) => tag.guildId === query.guildId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const start = (query.page - 1) * query.pageSize;
    return { tags: all.slice(start, start + query.pageSize), total: all.length };
  }

  async count(guildId: string): Promise<number> {
    return [...this.rows.values()].filter((tag) => tag.guildId === guildId).length;
  }

  async suggest(guildId: string, prefix: string, limit: number): Promise<string[]> {
    return [...this.rows.values()]
      .filter((tag) => tag.guildId === guildId && tag.name.startsWith(prefix))
      .map((tag) => tag.name)
      .sort()
      .slice(0, limit);
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
  response: RestResponse = { status: 200, body: {} };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

const store: GuildStateStore = {
  get: async () => guildState(),
  put: async () => undefined,
  patch: async () => undefined,
  delete: async () => undefined,
};

export interface RunOverrides {
  config: Partial<TagsConfig>;
  tier: EntitlementTier;
  deps: TagsDeps;
  idempotencyKey: string;
}

export interface CallBody {
  type?: number;
  data?: {
    content?: string;
    choices?: Array<{ name: string; value: string | number }>;
    allowed_mentions?: { parse?: string[] };
    flags?: number;
  };
}

export interface Harness {
  rest: FakeRest;
  tags: MemoryTagStore;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  bodies(): CallBody[];
  replyContent(): string | null;
  choices(): Array<{ name: string; value: string | number }>;

  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  autocomplete(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
}

export function harness(seed: TagsDeps = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: Array<{ level: string; message: string }> = [];
  const tags = new MemoryTagStore();

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
        { store, botUserId: BOT, fetchMemberRoles: async () => [] },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const bodies = (): CallBody[] => rest.calls.map((call) => call.body as CallBody);

  const depsOf = (overrides: Partial<RunOverrides>): TagsDeps =>
    overrides.deps ?? { store: tags, ...seed };

  return {
    rest,
    tags,
    recorder,
    logs,

    calls: () => rest.calls,
    bodies,

    replyContent: () =>
      bodies().find((body) => body.data?.content !== undefined)?.data?.content ?? null,

    choices: () => bodies().find((body) => body.data?.choices !== undefined)?.data?.choices ?? [],

    async run(command, options, overrides = {}) {
      const definition = tagsCommands(depsOf(overrides)).find((c) => c.name === command);
      if (!definition) throw new Error(`no such tags command: ${command}`);

      const ctx: CommandContext<TagsConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: MEMBER,
        config: { ...tagsDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor: executor.scoped({ channelId: CHANNEL, appPermissions: BOT_PERMISSIONS }),
        logger,
        options: createCommandOptions(options),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
      };

      await definition.handler(ctx);
    },

    async autocomplete(event, overrides = {}) {
      const ctx: ModuleContext<TagsConfig> = {
        guildId: GUILD,
        config: { ...tagsDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor: executor.scoped({ channelId: CHANNEL, appPermissions: BOT_PERMISSIONS }),
        logger,
      };

      await handleAutocomplete(event, ctx, depsOf(overrides));
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

export function autocompleteEvent(
  commandName: string,
  focusedValue: string,
  focusedName = 'name',
): ProtonEvent {
  return {
    id: newId(),
    type: 'interaction.autocomplete',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: BOT,
      type: 4,
      token: 'interaction-token',
      guild_id: GUILD,
      channel_id: CHANNEL,
      member: { user: { id: MEMBER }, roles: [] },
      data: {
        name: commandName,
        options: [
          { name: focusedName, type: OptionType.String, value: focusedValue, focused: true },
        ],
      },
    },
  };
}

export type { ActionRequest };
