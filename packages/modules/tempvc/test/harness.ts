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
} from '@proton/core';
import { tempVcCommands } from '../src/commands.ts';
import { type TempVcConfig, tempVcDefaultConfig, VOICE_CHANNEL_TYPE } from '../src/config.ts';
import type { TempVcDeps } from '../src/deps.ts';
import type { TempChannel, TempVcStore } from '../src/store.ts';
import { createTempVcListener } from '../src/voice.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '100000000000000001';
export const OTHER = '100000000000000002';
export const HUB = '500000000000000001';
export const CATEGORY = '500000000000000009';
export const TEMP = '500000000000000002';
export const CREATED = '500000000000000003';
export const INTERACTION = '600000000000000001';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

// Connect as well as MoveMembers: Discord will not let the bot move anyone into a channel it
// could not join itself, so the precheck asks for both in the destination.
export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.ManageChannels |
  Permissions.ManageRoles |
  Permissions.MoveMembers |
  Permissions.Connect;

export const seededOverwrites = new Map<
  string,
  Array<{ id: string; type: 0 | 1; allow: bigint; deny: bigint }>
>();

function guildState(botPermissions: bigint): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [
        HUB,
        {
          id: HUB,
          parentId: CATEGORY,
          type: VOICE_CHANNEL_TYPE,
          overwrites: seededOverwrites.get(HUB) ?? [],
        },
      ],
      [
        TEMP,
        {
          id: TEMP,
          parentId: CATEGORY,
          type: VOICE_CHANNEL_TYPE,
          overwrites: seededOverwrites.get(TEMP) ?? [],
        },
      ],
      [
        CREATED,
        {
          id: CREATED,
          parentId: CATEGORY,
          type: VOICE_CHANNEL_TYPE,
          overwrites: seededOverwrites.get(CREATED) ?? [],
        },
      ],
    ]),
    updatedAt: Date.now(),
  };
}

export class MemoryTempVcStore implements TempVcStore {
  readonly channels = new Map<string, TempChannel>();
  readonly occupancy = new Map<string, Set<string>>();
  readonly at = new Map<string, string>();

  #key(guildId: string, id: string): string {
    return `${guildId}:${id}`;
  }

  async claim(channel: TempChannel): Promise<void> {
    this.channels.set(this.#key(channel.guildId, channel.channelId), channel);
  }

  async get(guildId: string, channelId: string): Promise<TempChannel | null> {
    return this.channels.get(this.#key(guildId, channelId)) ?? null;
  }

  async ownedBy(guildId: string, userId: string): Promise<string | null> {
    for (const channel of this.channels.values()) {
      if (channel.guildId === guildId && channel.ownerId === userId) return channel.channelId;
    }
    return null;
  }

  async release(guildId: string, channelId: string): Promise<void> {
    this.channels.delete(this.#key(guildId, channelId));
    this.occupancy.delete(this.#key(guildId, channelId));
  }

  async all(guildId: string): Promise<string[]> {
    return [...this.channels.values()]
      .filter((channel) => channel.guildId === guildId)
      .map((channel) => channel.channelId);
  }

  async locate(guildId: string, userId: string): Promise<string | null> {
    return this.at.get(this.#key(guildId, userId)) ?? null;
  }

  async place(guildId: string, userId: string, channelId: string | null): Promise<void> {
    if (channelId === null) this.at.delete(this.#key(guildId, userId));
    else this.at.set(this.#key(guildId, userId), channelId);
  }

  #set(guildId: string, channelId: string): Set<string> {
    const key = this.#key(guildId, channelId);
    const existing = this.occupancy.get(key);
    if (existing) return existing;

    const created = new Set<string>();
    this.occupancy.set(key, created);
    return created;
  }

  async enter(guildId: string, channelId: string, userId: string): Promise<number> {
    const set = this.#set(guildId, channelId);
    set.add(userId);
    return set.size;
  }

  async leave(guildId: string, channelId: string, userId: string): Promise<number> {
    const set = this.#set(guildId, channelId);
    set.delete(userId);
    return set.size;
  }

  async occupants(guildId: string, channelId: string): Promise<number> {
    return this.#set(guildId, channelId).size;
  }

  async reset(guildId: string, channelId: string, userIds: readonly string[]): Promise<void> {
    this.occupancy.set(this.#key(guildId, channelId), new Set(userIds));
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

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

export interface RunOverrides {
  config: Partial<TempVcConfig>;
  deps: TempVcDeps;
  botPermissions: bigint;
  channelId: string;
  userId: string;
}

export interface Harness {
  rest: FakeRest;
  store: MemoryTempVcStore;

  overwrites: typeof seededOverwrites;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  discordCalls(): RestRequestOptions[];
  replyContent(): string | null;

  emit(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
  run(options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
}

export function harness(): Harness {
  const rest = new FakeRest();
  const store = new MemoryTempVcStore();
  const dedupe = new MemoryDedupe();
  const recorder = new MemoryRecorder();
  const logs: Array<{ level: string; message: string }> = [];

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

  const config = (overrides: Partial<RunOverrides>): TempVcConfig => ({
    ...tempVcDefaultConfig,
    enabled: true,
    hubs: [{ channelId: HUB, categoryId: CATEGORY, nameTemplate: '{user}’s room', userLimit: 0 }],
    ...overrides.config,
  });

  seededOverwrites.clear();

  return {
    rest,
    store,
    logs,
    overwrites: seededOverwrites,

    calls: () => rest.calls,
    discordCalls: () => rest.calls.filter((call) => !call.path.startsWith('/interactions/')),

    replyContent: () => {
      const call = rest.calls.find((c) => c.path.startsWith('/interactions/'));
      const body = call?.body as { data?: { content?: string } } | undefined;
      return body?.data?.content ?? null;
    },

    async emit(event, overrides = {}) {
      const listener = createTempVcListener(overrides.deps ?? { store });

      const ctx: ModuleContext<TempVcConfig> = {
        guildId: GUILD,
        config: config(overrides),
        tier: 'free',
        executor: executorFor(overrides.botPermissions ?? BOT_PERMISSIONS),
        logger,
      };

      await listener.handler(event, ctx);
    },

    async run(options, overrides = {}) {
      const definition = tempVcCommands(
        overrides.deps ?? {
          store,
          guildState: {
            get: async () => guildState(overrides.botPermissions ?? BOT_PERMISSIONS),
            put: async () => undefined,
            patch: async () => undefined,
            delete: async () => undefined,
          },
        },
      )[0];
      if (!definition) throw new Error('no /vc command');

      const ctx: CommandContext<TempVcConfig> = {
        guildId: GUILD,
        channelId: overrides.channelId ?? TEMP,
        userId: overrides.userId ?? MEMBER,
        config: config(overrides),
        tier: 'free',
        executor: executorFor(overrides.botPermissions ?? BOT_PERMISSIONS).scoped({
          channelId: overrides.channelId ?? TEMP,
          appPermissions: overrides.botPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        options: createCommandOptions(options),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: newId(),
      };

      await definition.handler(ctx);
    },
  };
}

export function voiceEvent(
  userId: string,
  channelId: string | null,
  options: { isBot?: boolean; nick?: string; id?: string } = {},
): ProtonEvent {
  return {
    id: options.id ?? newId(),
    type: 'voice.state_updated',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      guild_id: GUILD,
      user_id: userId,
      session_id: 'session',
      channel_id: channelId,
      member: {
        nick: options.nick ?? null,
        user: {
          id: userId,
          username: 'member',
          global_name: 'Member',
          bot: options.isBot === true,
        },
      },
    },
  };
}

export function guildAvailableEvent(
  voiceStates: Array<{ channelId: string; userId: string }>,
  channelIds: string[] | null = [HUB, TEMP, CREATED],
): ProtonEvent {
  return {
    id: newId(),
    type: 'guild.available',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: GUILD,
      voice_states: voiceStates.map((state) => ({
        channel_id: state.channelId,
        user_id: state.userId,
      })),
      ...(channelIds === null ? {} : { channels: channelIds.map((id) => ({ id })) }),
    },
  };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}
