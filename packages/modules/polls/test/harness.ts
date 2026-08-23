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
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
  type ScheduleOptions,
  type ScheduleOutcome,
} from '@proton/core';
import { createAnnounceHandler } from '../src/announce.ts';
import { pollsCommands } from '../src/commands.ts';
import { type PollsConfig, pollsDefaultConfig } from '../src/config.ts';
import type { PollsDeps } from '../src/deps.ts';
import type { CreatePollInput, PollRecord, PollStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '100000000000000001';
export const CHANNEL = '500000000000000001';
export const ANNOUNCE_CHANNEL = '500000000000000002';
export const INTERACTION = '600000000000000001';
export const POLL_MESSAGE = '700000000000000001';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

export const FULL_PERMISSIONS =
  Permissions.ViewChannel | Permissions.SendMessages | Permissions.SendPolls;

const SEND_MESSAGES_PATH = /^\/channels\/\d+\/messages$/;

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
      [ANNOUNCE_CHANNEL, { id: ANNOUNCE_CHANNEL, parentId: null, overwrites: [] }],
    ]),
    updatedAt: Date.now(),
  };
}

export class MemoryPollStore implements PollStore {
  readonly rows = new Map<string, PollRecord>();

  #key(guildId: string, messageId: string): string {
    return `${guildId}:${messageId}`;
  }

  async create(input: CreatePollInput): Promise<void> {
    const key = this.#key(input.guildId, input.messageId);
    if (this.rows.has(key)) return;

    this.rows.set(key, {
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      createdBy: input.createdBy,
      question: input.question,
      endsAt: input.endsAt,
      endedAt: null,
      announceChannelId: input.announceChannelId,
      createdAt: new Date(),
    });
  }

  async get(guildId: string, messageId: string): Promise<PollRecord | null> {
    return this.rows.get(this.#key(guildId, messageId)) ?? null;
  }

  async listRunning(guildId: string): Promise<PollRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.guildId === guildId && row.endedAt === null)
      .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
  }

  async countRunning(guildId: string, now: Date): Promise<number> {
    const running = await this.listRunning(guildId);
    return running.filter((row) => row.endsAt.getTime() > now.getTime()).length;
  }

  async end(guildId: string, messageId: string, endedAt: Date): Promise<boolean> {
    const key = this.#key(guildId, messageId);
    const row = this.rows.get(key);
    if (!row || row.endedAt !== null) return false;

    this.rows.set(key, { ...row, endedAt });
    return true;
  }
}

export class MemoryDedupe implements DedupeStore {
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

export interface RestFailure {
  match: RegExp;
  status: number;
  body?: unknown;
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  nextMessageId: string | null = POLL_MESSAGE;
  readonly failures: RestFailure[] = [];

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const failure = this.failures.find((entry) => entry.match.test(options.path));
    if (failure) {
      return { status: failure.status, body: failure.body ?? { message: 'Missing Access' } };
    }

    if (SEND_MESSAGES_PATH.test(options.path) && this.nextMessageId !== null) {
      return { status: 200, body: { id: this.nextMessageId } };
    }

    return { status: 200, body: {} };
  }
}

export interface ScheduledJob {
  jobId: string;
  runAt: Date;
  naturalKey: string;
  data: unknown;
  options: ScheduleOptions | undefined;
}

export interface RunOverrides {
  config: Partial<PollsConfig>;
  tier: EntitlementTier;
  deps: PollsDeps;
  idempotencyKey: string;
  botPermissions: bigint;

  withoutScheduler: boolean;
  scheduleOutcome: ScheduleOutcome;
}

export interface CallBody {
  type?: number;
  content?: string;
  poll?: {
    question?: { text?: string };
    answers?: Array<{ poll_media?: { text?: string } }>;
    duration?: number;
    allow_multiselect?: boolean;
  };
  allowed_mentions?: { parse?: string[] };
  flags?: number;
  data?: { content?: string; flags?: number; allowed_mentions?: { parse?: string[] } };
}

export interface Harness {
  rest: FakeRest;
  polls: MemoryPollStore;
  dedupe: MemoryDedupe;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;
  scheduled: ScheduledJob[];
  cancelled: Array<{ jobId: string; naturalKey: string }>;

  calls(): RestRequestOptions[];
  bodies(): CallBody[];

  sent(): Array<{ path: string; body: CallBody }>;
  answers(): string[];
  lastAnswer(): string | null;

  run(subcommand: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  announce(data: unknown, overrides?: Partial<RunOverrides>): Promise<void>;
}

export function harness(seed: PollsDeps = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: Array<{ level: string; message: string }> = [];
  const polls = new MemoryPollStore();
  const scheduled: ScheduledJob[] = [];
  const cancelled: Array<{ jobId: string; naturalKey: string }> = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const executorFor = (botPermissions: bigint) => {
    const store: GuildStateStore = {
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
          { store, botUserId: BOT, fetchMemberRoles: async () => [] },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    }).scoped({ channelId: CHANNEL, appPermissions: botPermissions });
  };

  const bodies = (): CallBody[] => rest.calls.map((call) => call.body as CallBody);

  const depsOf = (overrides: Partial<RunOverrides>): PollsDeps =>
    overrides.deps ?? { store: polls, applicationId: BOT, ...seed };

  const scheduleFns = (overrides: Partial<RunOverrides>) =>
    overrides.withoutScheduler
      ? {}
      : {
          schedule: async (
            jobId: string,
            runAt: Date,
            naturalKey: string,
            data?: unknown,
            options?: ScheduleOptions,
          ): Promise<ScheduleOutcome> => {
            scheduled.push({ jobId, runAt, naturalKey, data, options });
            return overrides.scheduleOutcome ?? { scheduled: true, replaced: false };
          },
          cancel: async (jobId: string, naturalKey: string): Promise<void> => {
            cancelled.push({ jobId, naturalKey });
          },
        };

  const answersOf = (): string[] =>
    rest.calls
      .filter((call) => call.path.startsWith('/webhooks/'))
      .map((call) => (call.body as CallBody).content ?? '');

  const repliesOf = (): string[] =>
    rest.calls
      .filter((call) => call.path.startsWith('/interactions/'))
      .map((call) => (call.body as CallBody).data?.content ?? '')
      .filter((content) => content.length > 0);

  return {
    rest,
    polls,
    dedupe,
    recorder,
    logs,
    scheduled,
    cancelled,

    calls: () => rest.calls,
    bodies,

    sent: () =>
      rest.calls
        .filter((call) => SEND_MESSAGES_PATH.test(call.path))
        .map((call) => ({ path: call.path, body: call.body as CallBody })),

    answers: () => [...answersOf(), ...repliesOf()],
    lastAnswer: () => [...answersOf(), ...repliesOf()].at(-1) ?? null,

    async run(subcommand, options, overrides = {}) {
      const definition = pollsCommands(depsOf(overrides)).find((c) => c.name === 'poll');
      if (!definition) throw new Error('no /poll command was built');

      const ctx: CommandContext<PollsConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: MEMBER,
        config: { ...pollsDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor: executorFor(overrides.botPermissions ?? FULL_PERMISSIONS),
        logger,
        options: createCommandOptions([{ name: subcommand, type: OptionType.Subcommand, options }]),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
        ...scheduleFns(overrides),
      };

      await definition.handler(ctx);
    },

    async announce(data, overrides = {}) {
      const ctx: ModuleContext<PollsConfig> = {
        guildId: GUILD,
        config: { ...pollsDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor: executorFor(overrides.botPermissions ?? FULL_PERMISSIONS),
        logger,
        ...scheduleFns(overrides),
      };

      await createAnnounceHandler(depsOf(overrides))(data, ctx);
    },
  };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function integerOption(name: string, value: number): RawOption {
  return { name, type: OptionType.Integer, value };
}

export function booleanOption(name: string, value: boolean): RawOption {
  return { name, type: OptionType.Boolean, value };
}

export type { PrecheckInput };
