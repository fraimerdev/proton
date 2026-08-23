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
import { messagesCommands } from '../src/commands.ts';
import { type MessagesConfig, messagesDefaultConfig, type SavedMessage } from '../src/config.ts';
import type { MessagesDeps } from '../src/deps.ts';
import { handleAutocomplete, handleModalSubmit } from '../src/interactions.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const APPLICATION = '800000000000000001';
export const MEMBER = '100000000000000001';
export const CHANNEL = '500000000000000001';
export const OTHER_CHANNEL = '500000000000000002';
export const INTERACTION = '600000000000000001';

export const ROLE = '410000000000000009';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

export const BOT_PERMISSIONS =
  Permissions.ViewChannel | Permissions.SendMessages | Permissions.EmbedLinks;

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
      [CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }],
      [OTHER_CHANNEL, { id: OTHER_CHANNEL, parentId: null, overwrites: [] }],
    ]),
    updatedAt: Date.now(),
  };
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

export interface RunOverrides {
  config: Partial<MessagesConfig>;
  templates: SavedMessage[];
  tier: EntitlementTier;
  deps: MessagesDeps;
  botPermissions: bigint;
  idempotencyKey: string;
}

export interface DiscordButton {
  type: number;
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface DiscordRow {
  type: number;
  components?: DiscordButton[];
}

export interface CallBody {
  type?: number;
  data?: {
    content?: string;
    custom_id?: string;
    title?: string;
    components?: Array<Record<string, unknown>>;
    choices?: Array<{ name: string; value: string | number }>;
    flags?: number;
  };
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  components?: DiscordRow[];
  allowed_mentions?: { parse?: string[]; roles?: string[]; users?: string[] };
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  bodies(): CallBody[];
  sends(): RestRequestOptions[];
  postedMessage(): CallBody | null;
  postedEmbed(): Record<string, unknown> | null;
  postedRows(): DiscordRow[];
  postedButtons(row?: number): DiscordButton[];
  callbackType(): number | null;
  modalOpened(): CallBody['data'] | null;
  choices(): Array<{ name: string; value: string | number }>;
  said(): string[];
  lastSaid(): string | null;

  run(options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  modal(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
  autocomplete(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
}

export function harness(seed: MessagesDeps = { applicationId: APPLICATION }): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: Array<{ level: string; message: string }> = [];

  let botPermissions = BOT_PERMISSIONS;

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const store: GuildStateStore = {
    get: async () => guildState(botPermissions),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
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

  const sends = (): RestRequestOptions[] =>
    rest.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/channels/'));

  const postedMessage = (): CallBody | null => (sends()[0]?.body as CallBody | undefined) ?? null;

  const postedRows = (): DiscordRow[] => postedMessage()?.components ?? [];

  const said = (): string[] => {
    const lines: string[] = [];
    for (const body of bodies()) {
      const content = body.data?.content ?? body.content;
      if (typeof content === 'string') lines.push(content);
    }
    return lines;
  };

  const configOf = (overrides: Partial<RunOverrides>): MessagesConfig => ({
    ...messagesDefaultConfig,
    enabled: true,
    ...(overrides.templates ? { templates: overrides.templates } : {}),
    ...overrides.config,
  });

  const contextOf = (overrides: Partial<RunOverrides>): ModuleContext<MessagesConfig> => {
    botPermissions = overrides.botPermissions ?? BOT_PERMISSIONS;

    return {
      guildId: GUILD,
      config: configOf(overrides),
      tier: overrides.tier ?? 'free',
      executor: executor.scoped({ channelId: CHANNEL, appPermissions: botPermissions }),
      logger,
    };
  };

  return {
    rest,
    recorder,
    logs,

    calls: () => rest.calls,
    bodies,
    sends,

    postedMessage,
    postedEmbed: () => postedMessage()?.embeds?.[0] ?? null,
    postedRows,
    postedButtons: (row = 0) => postedRows()[row]?.components ?? [],

    callbackType: () => bodies().find((body) => body.type !== undefined)?.type ?? null,

    modalOpened: () => bodies().find((body) => body.data?.custom_id !== undefined)?.data ?? null,

    choices: () => bodies().find((body) => body.data?.choices !== undefined)?.data?.choices ?? [],

    said,
    lastSaid: () => said().at(-1) ?? null,

    async run(options, overrides = {}) {
      const definition = messagesCommands(overrides.deps ?? seed)[0];
      if (!definition) throw new Error('the embeds module registered no commands');

      const base = contextOf(overrides);
      const ctx: CommandContext<MessagesConfig> = {
        ...base,
        channelId: CHANNEL,
        userId: MEMBER,
        options: createCommandOptions(options),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
      };

      await definition.handler(ctx);
    },

    async modal(event, overrides = {}) {
      await handleModalSubmit(event, contextOf(overrides), overrides.deps ?? seed);
    },

    async autocomplete(event, overrides = {}) {
      await handleAutocomplete(event, contextOf(overrides));
    },
  };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function channelOption(name: string, value: string): RawOption {
  return { name, type: OptionType.Channel, value };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export interface ModalEventOptions {
  customId?: string;
  channelId?: string | null;
}

export function modalEvent(
  fields: Record<string, string>,
  options: ModalEventOptions = {},
): ProtonEvent {
  const channelId = options.channelId === undefined ? CHANNEL : options.channelId;

  return {
    id: newId(),
    type: 'interaction.modal',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: APPLICATION,
      type: 5,
      token: 'modal-token',
      guild_id: GUILD,
      ...(channelId === null ? {} : { channel_id: channelId }),
      member: { user: { id: MEMBER }, roles: [] },
      data: {
        custom_id: options.customId ?? 'proton:messages:send',
        components: Object.entries(fields).map(([customId, value], index) => ({
          id: index + 1,
          type: 18,
          label: customId,
          component: { id: index + 100, type: 4, custom_id: customId, value },
        })),
      },
    },
  };
}

export interface AutocompleteEventOptions {
  commandName?: string;
  subcommand?: string;
  focusedName?: string;
}

export function autocompleteEvent(
  focusedValue: string,
  options: AutocompleteEventOptions = {},
): ProtonEvent {
  return {
    id: newId(),
    type: 'interaction.autocomplete',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: INTERACTION,
      application_id: APPLICATION,
      type: 4,
      token: 'interaction-token',
      guild_id: GUILD,
      channel_id: CHANNEL,
      member: { user: { id: MEMBER }, roles: [] },
      data: {
        name: options.commandName ?? 'embed',
        options: [
          {
            name: options.subcommand ?? 'post',
            type: OptionType.Subcommand,
            options: [
              {
                name: options.focusedName ?? 'name',
                type: OptionType.String,
                value: focusedValue,
                focused: true,
              },
            ],
          },
        ],
      },
    },
  };
}
