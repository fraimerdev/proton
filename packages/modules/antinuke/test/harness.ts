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
  type RateWindowHit,
  type RateWindowStore,
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { createAntinukeCommands } from '../src/commands.ts';
import { type AntinukeConfig, antinukeDefaultConfig } from '../src/config.ts';
import type { AntinukeDeps } from '../src/deps.ts';
import { type AntinukeOutcome, handleDestructiveEvent } from '../src/listeners.ts';
import type { MaintenanceStore, MaintenanceWindow } from '../src/maintenance.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const ADMIN = '100000000000000001';
export const ALERT_CHANNEL = '500000000000000001';
export const COMMAND_CHANNEL = '500000000000000002';

/** The compromised admin in the Gate 2 fixture. */
export const NUKER = '200000000000000009';

export const EVERYONE_ROLE = GUILD;
export const NUKER_LOW_ROLE = '410000000000000002';
export const NUKER_HIGH_ROLE = '410000000000000004';
const BOT_ROLE = '410000000000000008';

/** Everything the breaker and its alert need, as Discord would report it. */
export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.ViewAuditLog |
  Permissions.ManageRoles |
  Permissions.BanMembers |
  Permissions.KickMembers;

export const NOW = Date.parse('2026-08-15T12:00:00.000Z');

function roles(): Map<string, GuildRole> {
  return new Map<string, GuildRole>([
    [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
    [NUKER_LOW_ROLE, { id: NUKER_LOW_ROLE, permissions: 0n, position: 2 }],
    [NUKER_HIGH_ROLE, { id: NUKER_HIGH_ROLE, permissions: 0n, position: 4 }],
    [BOT_ROLE, { id: BOT_ROLE, permissions: 0n, position: 8 }],
  ]);
}

/** Role ids per member, as `fetchMemberRoles` would answer. */
const MEMBER_ROLES: Record<string, string[]> = {
  // @everyone is in here on purpose: removing it is a call Discord rejects, so
  // the breaker has to filter it out rather than discover that at runtime.
  [NUKER]: [EVERYONE_ROLE, NUKER_LOW_ROLE, NUKER_HIGH_ROLE],
  [OWNER]: [NUKER_HIGH_ROLE],
  [ADMIN]: [NUKER_LOW_ROLE],
  [BOT]: [BOT_ROLE],
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

/**
 * A rate window whose verdict the test states outright.
 *
 * Counting is `RedisRateWindow`'s job and is proved against real Redis in
 * `antinuke.integration.test.ts`; re-deriving its semantics here would be a
 * second implementation to keep in step with the first. What these tests need is
 * control over "has the threshold been crossed", so that is what this exposes.
 */
export class FakeRateWindow implements RateWindowStore {
  readonly hits: RateWindowHit[] = [];
  tripped = false;
  count = 3;

  async hit(input: RateWindowHit) {
    this.hits.push(input);
    return { count: this.count, tripped: this.tripped };
  }
}

export class MemoryMaintenanceStore implements MaintenanceStore {
  readonly windows = new Map<string, MaintenanceWindow>();

  async get(guildId: string): Promise<MaintenanceWindow | null> {
    return this.windows.get(guildId) ?? null;
  }

  async set(window: MaintenanceWindow): Promise<void> {
    this.windows.set(window.guildId, window);
  }

  async clear(guildId: string): Promise<void> {
    this.windows.delete(guildId);
  }
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface HarnessOptions {
  /** Swap in the real `RedisRateWindow` for the integration suite. */
  rateWindow?: RateWindowStore;
  maintenance?: MaintenanceStore;
  /** Defaults to the full set; drop bits to exercise the I8 failures. */
  botPermissions?: bigint;
  /** Roles per member, when a test needs a member with none. */
  memberRoles?: Record<string, string[]>;
  /** Ports to leave unbound, for the "enabled but not protecting you" path. */
  omit?: Array<keyof AntinukeDeps>;
  /** Share the clock with a store built outside the harness. */
  clock?: { now: number };
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  logs: LogLine[];
  rateWindow: RateWindowStore;
  maintenance: MaintenanceStore;
  deps: AntinukeDeps;
  /** The clock the maintenance window is judged against; tests move it. */
  clock: { now: number };
  handle(event: ProtonEvent, config?: Partial<AntinukeConfig>): Promise<AntinukeOutcome>;
  runCommand(options: RawOption[], config?: Partial<AntinukeConfig>): Promise<void>;
  /** REST calls that are not the interaction acknowledgement. */
  discordCalls(): RestRequestOptions[];
  /** `METHOD path` per call, in order — what the ordering assertions read. */
  callPaths(): string[];
  cases(): CaseInput[];
  replyContent(): string | null;
  /** What the alert channel was told, if anything. */
  alertContent(): string | null;
  logged(level: LogLine['level'], fragment: string): boolean;
}

export function harness(options: HarnessOptions = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: LogLine[] = [];
  const clock = options.clock ?? { now: NOW };
  const rateWindow = options.rateWindow ?? new FakeRateWindow();
  const maintenance = options.maintenance ?? new MemoryMaintenanceStore();
  const memberRoles = options.memberRoles ?? MEMBER_ROLES;
  const omit = new Set<keyof AntinukeDeps>(options.omit ?? []);

  const state: GuildState = {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: roles(),
    botRoleIds: [BOT_ROLE],
    channels: new Map([
      [ALERT_CHANNEL, { id: ALERT_CHANNEL, parentId: null, overwrites: [] }],
      [COMMAND_CHANNEL, { id: COMMAND_CHANNEL, parentId: null, overwrites: [] }],
    ]),
    updatedAt: NOW,
  };

  // The bot's own role carries the permissions, so dropping a bit here is
  // exactly what an admin editing that role in Discord would do.
  const botRole = state.roles.get(BOT_ROLE);
  if (botRole) botRole.permissions = options.botPermissions ?? BOT_PERMISSIONS;

  const store: GuildStateStore = {
    get: async () => state,
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const fetchMemberRoles = async (_guildId: string, userId: string): Promise<string[] | null> =>
    memberRoles[userId] ?? null;

  const deps: AntinukeDeps = { now: () => clock.now };
  if (!omit.has('rateWindow')) deps.rateWindow = rateWindow;
  if (!omit.has('maintenance')) deps.maintenance = maintenance;
  if (!omit.has('guildState')) deps.guildState = store;
  if (!omit.has('fetchMemberRoles')) deps.fetchMemberRoles = fetchMemberRoles;
  if (!omit.has('botUserId')) deps.botUserId = BOT;

  const executor = new DefaultActionExecutor({
    dedupe,
    rest,
    recorder,
    resolveContext: async (
      request,
      hints,
    ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
      const resolved = await resolvePrecheckContext(
        { store, botUserId: BOT, fetchMemberRoles },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  return {
    rest,
    recorder,
    logs,
    rateWindow,
    maintenance,
    deps,
    clock,

    async handle(event, config = {}) {
      const ctx: ModuleContext<AntinukeConfig> = {
        guildId: GUILD,
        config: { ...antinukeDefaultConfig, ...config },
        executor,
        logger,
      };
      return handleDestructiveEvent(event, ctx, deps);
    },

    async runCommand(raw, config = {}) {
      const command = createAntinukeCommands(deps)[0];
      if (!command) throw new Error('the antinuke module declares no commands');

      const ctx: CommandContext<AntinukeConfig> = {
        guildId: GUILD,
        channelId: COMMAND_CHANNEL,
        userId: ADMIN,
        config: { ...antinukeDefaultConfig, ...config },
        // Exactly what apps/worker binds: Discord's own permission computation
        // for the interaction's channel.
        executor: executor.scoped({
          channelId: COMMAND_CHANNEL,
          appPermissions: options.botPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        options: createCommandOptions(raw),
        interaction: { id: '600000000000000001', token: 'interaction-token' },
        idempotencyKey: newId(),
      };

      await command.handler(ctx);
    },

    discordCalls: () => rest.calls.filter((call) => !call.path.startsWith('/interactions/')),
    callPaths: () => rest.calls.map((call) => `${call.method} ${call.path}`),
    cases: () => recorder.recorded.filter((c) => c.kind !== 'interaction_reply'),

    replyContent() {
      const call = rest.calls.find((c) => c.path.startsWith('/interactions/'));
      const body = call?.body as { data?: { content?: string } } | undefined;
      return body?.data?.content ?? null;
    },

    alertContent() {
      const call = rest.calls.find((c) => c.path === `/channels/${ALERT_CHANNEL}/messages`);
      const body = call?.body as { content?: string } | undefined;
      return body?.content ?? null;
    },

    logged: (level, fragment) =>
      logs.some((line) => line.level === level && line.message.includes(fragment)),
  };
}

let entrySeed = 1_537_751_140_794_499_072n;

/** One snowflake per call, each a millisecond after the last (1<<22 per ms). */
function nextEntryId(): string {
  entrySeed += 4_194_304n;
  return String(entrySeed);
}

/**
 * An audit-derived event as the normaliser produces one.
 *
 * Entry ids advance so each event is distinct — the rate window dedupes on the
 * event id (I4), and a test that reused one would be counting one deletion
 * twenty times.
 */
export function auditEvent(
  type: string,
  overrides: { actorId?: string | null; occurredAt?: number; entryId?: string } = {},
): ProtonEvent {
  const entryId = overrides.entryId ?? nextEntryId();
  const actorId = overrides.actorId === undefined ? NUKER : overrides.actorId;

  return {
    id: `${type}:${entryId}`,
    type: type as ProtonEvent['type'],
    guildId: GUILD,
    occurredAt: overrides.occurredAt ?? NOW,
    payload: {
      entryId,
      guildId: GUILD,
      actionType: 12,
      actorId,
      targetId: '500000000000001100',
      reason: null,
    },
  };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}
