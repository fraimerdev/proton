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
  type ScheduleOptions,
  type ScheduleOutcome,
} from '@proton/core';
import { handleAutocomplete } from '../src/autocomplete.ts';
import { remindersCommands } from '../src/commands.ts';
import { type RemindersConfig, remindersDefaultConfig } from '../src/config.ts';
import { deliverReminder } from '../src/deliver.ts';
import type { RemindersDeps } from '../src/deps.ts';
import type { CreateReminderInput, PendingQuery, Reminder, ReminderStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '100000000000000001';
export const OTHER = '100000000000000002';
export const CHANNEL = '500000000000000001';
export const INTERACTION = '600000000000000001';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

const BOT_PERMISSIONS = Permissions.ViewChannel | Permissions.SendMessages;

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
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

export class MemoryReminderStore implements ReminderStore {
  readonly rows = new Map<string, Reminder>();

  async create(input: CreateReminderInput): Promise<Reminder | null> {
    if (this.rows.has(input.id)) return null;

    const reminder: Reminder = {
      id: input.id,
      guildId: input.guildId,
      userId: input.userId,
      channelId: input.channelId,
      content: input.content,
      remindAt: input.remindAt,
      createdAt: new Date(),
      deliveredAt: null,
    };

    this.rows.set(reminder.id, reminder);
    return reminder;
  }

  async get(guildId: string, id: string): Promise<Reminder | null> {
    const reminder = this.rows.get(id);
    return reminder && reminder.guildId === guildId ? reminder : null;
  }

  async pending(query: PendingQuery): Promise<Reminder[]> {
    const search = query.search?.trim().toLowerCase() ?? '';

    return [...this.rows.values()]
      .filter(
        (reminder) =>
          reminder.guildId === query.guildId &&
          reminder.userId === query.userId &&
          reminder.deliveredAt === null &&
          (search.length === 0 || reminder.content.toLowerCase().includes(search)),
      )
      .sort((a, b) => a.remindAt.getTime() - b.remindAt.getTime())
      .slice(0, query.limit);
  }

  async countPending(guildId: string, userId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (reminder) =>
        reminder.guildId === guildId && reminder.userId === userId && reminder.deliveredAt === null,
    ).length;
  }

  async remove(guildId: string, id: string, userId: string): Promise<boolean> {
    const reminder = this.rows.get(id);
    if (!reminder || reminder.guildId !== guildId || reminder.userId !== userId) return false;

    return this.rows.delete(id);
  }

  async markDelivered(guildId: string, id: string, deliveredAt: Date): Promise<boolean> {
    const reminder = this.rows.get(id);
    if (!reminder || reminder.guildId !== guildId || reminder.deliveredAt !== null) return false;

    this.rows.set(id, { ...reminder, deliveredAt });
    return true;
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

  throws: string | null = null;

  schedule = async (
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<ScheduleOutcome> => {
    if (this.throws !== null) throw new Error(this.throws);

    this.booked.push({ jobId, runAt, naturalKey, data, ...(options ? { options } : {}) });
    return { scheduled: true, replaced: false };
  };

  cancel = async (jobId: string, naturalKey: string): Promise<void> => {
    this.cancelled.push({ jobId, naturalKey });
  };
}

export interface RunOverrides {
  config: Partial<RemindersConfig>;
  tier: EntitlementTier;
  deps: RemindersDeps;
  idempotencyKey: string;
  userId: string;

  scheduler: boolean;
}

export interface CallBody {
  type?: number;
  data?: {
    content?: string;
    choices?: Array<{ name: string; value: string | number }>;
    allowed_mentions?: { parse?: string[]; users?: string[] };
    flags?: number;
  };
  content?: string;
  allowed_mentions?: { parse?: string[]; users?: string[] };
}

export interface Harness {
  rest: FakeRest;
  reminders: MemoryReminderStore;
  recorder: MemoryRecorder;
  scheduler: FakeScheduler;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  bodies(): CallBody[];
  replyContent(): string | null;
  sent(): CallBody[];
  choices(): Array<{ name: string; value: string | number }>;

  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  autocomplete(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<void>;
  deliver(data: unknown, overrides?: Partial<RunOverrides>): Promise<void>;
}

export interface HarnessOptions {
  deps?: RemindersDeps;
  botPermissions?: bigint;
}

export function harness(options: HarnessOptions = {}): Harness {
  const botPermissions = options.botPermissions ?? BOT_PERMISSIONS;

  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const scheduler = new FakeScheduler();
  const logs: Array<{ level: string; message: string }> = [];
  const reminders = new MemoryReminderStore();

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

  const depsOf = (overrides: Partial<RunOverrides>): RemindersDeps =>
    overrides.deps ?? options.deps ?? { store: reminders };

  const scoped = executor.scoped({ channelId: CHANNEL, appPermissions: botPermissions });

  return {
    rest,
    reminders,
    recorder,
    scheduler,
    logs,

    calls: () => rest.calls,
    bodies,

    replyContent: () =>
      bodies().find((body) => body.data?.content !== undefined)?.data?.content ?? null,

    sent: () => bodies().filter((body) => body.content !== undefined),

    choices: () => bodies().find((body) => body.data?.choices !== undefined)?.data?.choices ?? [],

    async run(command, options_, overrides = {}) {
      const definition = remindersCommands(depsOf(overrides)).find((c) => c.name === command);
      if (!definition) throw new Error(`no such reminders command: ${command}`);

      const ctx: CommandContext<RemindersConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: overrides.userId ?? MEMBER,
        config: { ...remindersDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor: scoped,
        logger,
        options: createCommandOptions(options_),
        interaction: { id: INTERACTION, token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),

        ...(overrides.scheduler === false
          ? {}
          : { schedule: scheduler.schedule, cancel: scheduler.cancel }),
      };

      await definition.handler(ctx);
    },

    async autocomplete(event, overrides = {}) {
      const ctx: ModuleContext<RemindersConfig> = {
        guildId: GUILD,
        config: { ...remindersDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor: scoped,
        logger,
      };

      await handleAutocomplete(event, ctx, depsOf(overrides));
    },

    async deliver(data, overrides = {}) {
      const ctx: ModuleContext<RemindersConfig> = {
        guildId: GUILD,
        config: { ...remindersDefaultConfig, enabled: true, ...overrides.config },
        tier: overrides.tier ?? 'free',
        executor,
        logger,
      };

      await deliverReminder(data, ctx, depsOf(overrides));
    },
  };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function subcommand(name: string, options: RawOption[]): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function autocompleteEvent(
  commandName: string,
  focusedValue: string,
  focusedName = 'reminder',
  userId = MEMBER,
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
      member: { user: { id: userId }, roles: [] },
      data: {
        name: commandName,
        options: [
          {
            name: 'cancel',
            type: OptionType.Subcommand,
            options: [
              { name: focusedName, type: OptionType.String, value: focusedValue, focused: true },
            ],
          },
        ],
      },
    },
  };
}
