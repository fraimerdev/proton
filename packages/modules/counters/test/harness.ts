import {
  type CaseInput,
  type CaseRecorder,
  type ChannelState,
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
  type ScheduleOptions,
  type ScheduleOutcome,
} from '@proton/core';
import { countersCommands } from '../src/commands.ts';
import { type CountersConfig, countersDefaultConfig } from '../src/config.ts';
import type { CountersDeps } from '../src/deps.ts';
import { reconcileSchedule } from '../src/listener.ts';
import { createRefreshHandler } from '../src/refresh.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const ADMIN = '100000000000000001';
export const CHANNEL = '500000000000000001';
export const COUNTER_A = '500000000000000002';
export const COUNTER_B = '500000000000000003';
export const INTERACTION = '600000000000000001';

export const EVERYONE_ROLE = GUILD;
export const BOT_ROLE = '410000000000000005';
export const EXTRA_ROLE = '410000000000000009';

export const BOT_PERMISSIONS =
  Permissions.ViewChannel | Permissions.SendMessages | Permissions.ManageChannels;

export const MEMBER_COUNT = 1234;

const VOICE_TYPE = 2;
const TEXT_TYPE = 0;

export function voiceChannel(id: string, name: string): ChannelState {
  return { id, parentId: null, type: VOICE_TYPE, name, overwrites: [] };
}

export function guildState(botPermissions: bigint = BOT_PERMISSIONS): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
      [EXTRA_ROLE, { id: EXTRA_ROLE, permissions: 0n, position: 9 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map<string, ChannelState>([
      [CHANNEL, { id: CHANNEL, parentId: null, type: TEXT_TYPE, name: 'general', overwrites: [] }],
      [COUNTER_A, voiceChannel(COUNTER_A, 'Members: 0')],
      [COUNTER_B, voiceChannel(COUNTER_B, 'Roles: 0')],
    ]),
    memberCount: MEMBER_COUNT,
    updatedAt: Date.now(),
  };
}

export const NO_CACHED_STATE: GuildStateStore = {
  get: async () => null,
  put: async () => undefined,
  patch: async () => undefined,
  delete: async () => undefined,
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

export interface BookedJob {
  jobId: string;
  runAt: Date;
  naturalKey: string;
  data: unknown;
  options?: ScheduleOptions;
}

export class FakeScheduler {
  readonly booked: BookedJob[] = [];
  readonly cancelled: Array<{ jobId: string; naturalKey: string }> = [];

  schedule = async (
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<ScheduleOutcome> => {
    this.booked.push({ jobId, runAt, naturalKey, data, ...(options ? { options } : {}) });
    return { scheduled: true, replaced: false };
  };

  cancel = async (jobId: string, naturalKey: string): Promise<void> => {
    this.cancelled.push({ jobId, naturalKey });
  };
}

export interface RunOverrides {
  config: Partial<CountersConfig>;
  tier: EntitlementTier;
  deps: CountersDeps;
  idempotencyKey: string;

  scheduler: boolean;
}

export interface CallBody {
  name?: string;
  data?: { content?: string; flags?: number };
}

export interface HarnessOptions {
  deps?: CountersDeps;
  botPermissions?: bigint;
}

export interface Harness {
  rest: FakeRest;
  state: GuildState;
  recorder: MemoryRecorder;
  scheduler: FakeScheduler;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  patches(): RestRequestOptions[];
  replyContent(): string | null;

  run(options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  refresh(overrides?: Partial<RunOverrides>): Promise<void>;
  listen(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
}

export function harness(options: HarnessOptions = {}): Harness {
  const state = guildState(options.botPermissions ?? BOT_PERMISSIONS);

  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const scheduler = new FakeScheduler();
  const logs: Array<{ level: string; message: string }> = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const store: GuildStateStore = {
    get: async () => state,
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

  const scoped = executor.scoped({
    channelId: CHANNEL,
    appPermissions: options.botPermissions ?? BOT_PERMISSIONS,
  });

  const depsOf = (overrides: Partial<RunOverrides>): CountersDeps =>
    overrides.deps ?? options.deps ?? { guildState: store };

  const configOf = (overrides: Partial<RunOverrides>): CountersConfig => ({
    ...countersDefaultConfig,
    enabled: true,
    ...overrides.config,
  });

  const scheduling = (overrides: Partial<RunOverrides>) =>
    overrides.scheduler === false ? {} : { schedule: scheduler.schedule, cancel: scheduler.cancel };

  return {
    rest,
    state,
    recorder,
    scheduler,
    logs,

    calls: () => rest.calls,

    patches: () =>
      rest.calls.filter((call) => call.method === 'PATCH' && call.path.startsWith('/channels/')),

    replyContent: () => {
      const call = rest.calls.find((c) => c.path.startsWith('/interactions/'));
      return (call?.body as CallBody | undefined)?.data?.content ?? null;
    },

    async run(raw, overrides = {}) {
      const definition = countersCommands(depsOf(overrides))[0];
      if (!definition) throw new Error('the counters module declares no commands');

      const ctx: CommandContext<CountersConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: ADMIN,
        config: configOf(overrides),
        tier: overrides.tier ?? 'free',
        executor: scoped,
        logger,
        options: createCommandOptions(raw),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),

        ...scheduling(overrides),
      };

      await definition.handler(ctx);
    },

    async refresh(overrides = {}) {
      await createRefreshHandler(depsOf(overrides))(undefined, moduleCtx(overrides));
    },

    async listen(event, overrides = {}) {
      await reconcileSchedule(event, moduleCtx(overrides));
    },
  };

  function moduleCtx(overrides: Partial<RunOverrides>): ModuleContext<CountersConfig> {
    return {
      guildId: GUILD,
      config: configOf(overrides),
      tier: overrides.tier ?? 'free',
      executor,
      logger,

      ...scheduling(overrides),
    };
  }
}

export function subcommand(name: string): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options: [] }];
}

export function protonEvent(
  type: ProtonEvent['type'],
  payload: unknown,
  id = 'evt-1',
): ProtonEvent {
  return { id, type, guildId: GUILD, occurredAt: 1_700_000_000_000, payload };
}
