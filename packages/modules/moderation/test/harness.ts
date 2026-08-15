import {
  type ActionRequest,
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
  newId,
  OptionType,
  Permissions,
  type PrecheckInput,
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import type { ModerationConfig } from '../src/config.ts';
import { moderationDefaultConfig } from '../src/config.ts';
import { moderationModule } from '../src/index.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MODERATOR = '100000000000000001';
export const CHANNEL = '500000000000000001';

/** A member below the bot: every action on them should be allowed. */
export const MEMBER = '400000000000000001';
/** A member whose top role sits above the bot's: I8 must refuse. */
export const ABOVE_BOT = '400000000000000002';

const EVERYONE_ROLE = GUILD;
const LOW_ROLE = '410000000000000001';
const BOT_ROLE = '410000000000000005';
const HIGH_ROLE = '410000000000000009';

/** Everything the moderation commands need, as Discord would report it. */
export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.BanMembers |
  Permissions.KickMembers |
  Permissions.ModerateMembers |
  Permissions.ManageChannels |
  Permissions.ManageRoles;

function roles(): Map<string, GuildRole> {
  return new Map<string, GuildRole>([
    [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
    [LOW_ROLE, { id: LOW_ROLE, permissions: 0n, position: 1 }],
    [BOT_ROLE, { id: BOT_ROLE, permissions: BOT_PERMISSIONS, position: 5 }],
    [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: 9 }],
  ]);
}

function guildState(): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: roles(),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

/** Role ids per member — what an interaction's `resolved.members` would carry. */
const MEMBER_ROLES: Record<string, string[]> = {
  [MEMBER]: [LOW_ROLE],
  [ABOVE_BOT]: [HIGH_ROLE],
  [OWNER]: [LOW_ROLE],
};

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

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  scheduled: Array<{ request: ActionRequest; caseId: string }>;
  logs: Array<{ level: string; message: string }>;
  /** REST calls that are not the interaction acknowledgement. */
  discordCalls(): RestRequestOptions[];
  /** Recorded cases, minus the one every reply writes. */
  cases(): CaseInput[];
  /** What the moderator was told, or null if nothing was sent. */
  replyContent(): string | null;
  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
}

export interface RunOverrides {
  config: Partial<ModerationConfig>;
  /** Overrides Discord's `app_permissions` for the interaction channel. */
  appPermissions: bigint;
  /** Reused between two runs to exercise redelivery (I4). */
  idempotencyKey: string;
  /** Fails the reversal scheduler, to prove the module reports what did not happen. */
  scheduleReversal: (request: ActionRequest, caseId: string) => Promise<void>;
}

const store: GuildStateStore = {
  get: async () => guildState(),
  put: async () => undefined,
  patch: async () => undefined,
  delete: async () => undefined,
};

/**
 * A moderation command wired to the real executor.
 *
 * Only the REST proxy is faked. The prechecks, the guild-state resolution, the
 * hierarchy arithmetic and the dedupe claim are all the production code paths —
 * which is the point: the Gate 0 stub passed its tests precisely because those
 * were replaced with permissive fakes.
 */
export function harness(): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const scheduled: Array<{ request: ActionRequest; caseId: string }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  // Shared across runs so a redelivered interaction meets the claim the first
  // delivery made (I4).
  const dedupe = new MemoryDedupe();

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const discordCalls = () => rest.calls.filter((call) => !call.path.startsWith('/interactions/'));

  const replyContent = (): string | null => {
    const call = rest.calls.find((c) => c.path.startsWith('/interactions/'));
    const body = call?.body as { data?: { content?: string } } | undefined;
    return body?.data?.content ?? null;
  };

  return {
    rest,
    recorder,
    scheduled,
    logs,
    discordCalls,
    replyContent,
    cases: () => recorder.recorded.filter((c) => c.kind !== 'interaction_reply'),

    async run(command, options, overrides = {}) {
      const definition = moderationModule.commands?.find((c) => c.name === command);
      if (!definition) throw new Error(`no such moderation command: ${command}`);

      const executor = new DefaultActionExecutor({
        dedupe,
        rest,
        recorder,
        scheduleReversal:
          overrides.scheduleReversal ??
          (async (request, caseId) => {
            scheduled.push({ request, caseId });
          }),
        resolveContext: async (
          request,
          hints,
        ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
          const resolved = await resolvePrecheckContext(
            {
              store,
              botUserId: BOT,
              fetchMemberRoles: async (_guildId, userId) => MEMBER_ROLES[userId] ?? null,
            },
            request,
            (hints ?? {}) as ResolveContextHints,
          );
          return 'context' in resolved ? resolved.context : resolved;
        },
      });

      const ctx: CommandContext<ModerationConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: MODERATOR,
        config: { ...moderationDefaultConfig, ...overrides.config },
        // Exactly what apps/worker binds: Discord's own permission computation
        // for this channel, plus the channel the interaction came from.
        executor: executor.scoped({
          channelId: CHANNEL,
          appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        options: createCommandOptions(options),
        interaction: { id: '600000000000000001', token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
      };

      await definition.handler(ctx);
    },
  };
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}
