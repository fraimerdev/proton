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
  newCaseId,
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
import { createModerationModule, ROLE_RUN_JOB } from '../src/index.ts';
import type { GuildMemberLister, GuildMemberSummary, MemberPageResult } from '../src/members.ts';
import type { RoleRun, RoleRunStore } from '../src/run-store.ts';
import type { StandingWarning, WarningStore, WithdrawInput } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MODERATOR = '100000000000000001';
export const CHANNEL = '500000000000000001';
export const APPLICATION_ID = '1200000000000000001';

export const MEMBER = '400000000000000001';

export const ABOVE_BOT = '400000000000000002';

const EVERYONE_ROLE = GUILD;
const LOW_ROLE = '410000000000000001';
const BOT_ROLE = '410000000000000005';
const HIGH_ROLE = '410000000000000009';

/** Below both the bot and the moderator, so handing it out passes every hierarchy check. */
export const GRANT_ROLE = '410000000000000002';

export const MANAGED_ROLE = '410000000000000003';

/** The moderator's own highest role, between GRANT_ROLE and the bot's. */
export const MOD_ROLE = '410000000000000004';

export { EVERYONE_ROLE, HIGH_ROLE, LOW_ROLE };

export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.BanMembers |
  Permissions.KickMembers |
  Permissions.ModerateMembers |
  Permissions.ManageChannels |
  Permissions.ManageRoles;

function roles(botPermissions: bigint): Map<string, GuildRole> {
  return new Map<string, GuildRole>([
    [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
    [LOW_ROLE, { id: LOW_ROLE, permissions: 0n, position: 1 }],
    [GRANT_ROLE, { id: GRANT_ROLE, permissions: 0n, position: 2, managed: false }],
    [MANAGED_ROLE, { id: MANAGED_ROLE, permissions: 0n, position: 3, managed: true }],
    [MOD_ROLE, { id: MOD_ROLE, permissions: 0n, position: 4 }],
    [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
    [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: 9 }],
  ]);
}

function guildState(botPermissions: bigint): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: roles(botPermissions),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

const MEMBER_ROLES: Record<string, string[]> = {
  [MEMBER]: [LOW_ROLE],
  [ABOVE_BOT]: [HIGH_ROLE],
  [OWNER]: [LOW_ROLE],
  [MODERATOR]: [MOD_ROLE],
};

/** Resolves to no member at all, for the paths that must refuse rather than guess. */
export const LEFT_MEMBER = '400000000000000777';

// Everyone else is a member holding @everyone and nothing more, which is what most of a real
// guild looks like — MEMBER_ROLES only has to name the ones whose rank a test turns on.
function rolesOf(userId: string): string[] | null {
  if (userId === LEFT_MEMBER) return null;
  return MEMBER_ROLES[userId] ?? [];
}

export class MemoryRoleRunStore implements RoleRunStore {
  readonly runs = new Map<string, RoleRun>();

  async get(guildId: string): Promise<RoleRun | null> {
    return this.runs.get(guildId) ?? null;
  }

  async put(run: RoleRun): Promise<void> {
    this.runs.set(run.guildId, { ...run });
  }

  async clear(guildId: string): Promise<void> {
    this.runs.delete(guildId);
  }
}

export class FakeMemberLister implements GuildMemberLister {
  pages: GuildMemberSummary[][] = [];
  failure: string | null = null;
  retryable = false;
  readonly asked: string[] = [];

  async list(_guildId: string, after: string, _limit: number): Promise<MemberPageResult> {
    this.asked.push(after);
    if (this.failure) return { failure: this.failure, retryable: this.retryable };

    const index = after === '0' ? 0 : Number(after);
    const members = this.pages[index] ?? [];

    return { members, next: index + 1 < this.pages.length ? String(index + 1) : null };
  }
}

export interface ScheduledJobCall {
  jobId: string;
  runAt: Date;
  naturalKey: string;
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
    return { caseId: newCaseId() };
  }
}

export class MemoryWarningStore implements WarningStore {
  readonly warnings = new Map<string, StandingWarning & { guildId: string }>();

  seed(guildId: string, warning: StandingWarning): void {
    this.warnings.set(`${guildId}:${warning.caseId}`, { ...warning, guildId });
  }

  async find(guildId: string, caseId: string): Promise<StandingWarning | null> {
    return this.warnings.get(`${guildId}:${caseId}`) ?? null;
  }

  async withdraw(input: WithdrawInput): Promise<boolean> {
    const found = this.warnings.get(`${input.guildId}:${input.caseId}`);
    if (!found || found.revertedAt) return false;

    found.revertedAt = input.at;
    found.revertedBy = input.by;
    return true;
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

export interface PublishedEvent {
  type: string;
  naturalKey: string;
  payload: unknown;
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  warnings: MemoryWarningStore;
  roleRuns: MemoryRoleRunStore;
  members: FakeMemberLister;
  jobs: ScheduledJobCall[];

  runJob(overrides?: Partial<RunOverrides>): Promise<void>;
  scheduled: Array<{ request: ActionRequest; caseId: string }>;
  logs: Array<{ level: string; message: string }>;

  published: PublishedEvent[];

  discordCalls(): RestRequestOptions[];

  cases(): CaseInput[];

  replyContent(): string | null;
  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
}

export interface RunOverrides {
  config: Partial<ModerationConfig>;

  appPermissions: bigint;

  // A guild-scoped kind never reads app_permissions, so taking a permission away from a ban or a
  // kick means taking it off the bot's role.
  botPermissions: bigint;

  idempotencyKey: string;

  scheduleReversal: (request: ActionRequest, caseId: string) => Promise<void>;

  // Null stands for the binding the api and the landing page build the module without.
  warnings: WarningStore | null;

  actorRoleIds: string[] | undefined;
  unbindRoleDeps: boolean;

  /** Runs the command as the guild owner, who outranks every role by definition. */
  asOwner: boolean;
}

function stateStore(botPermissions: bigint): GuildStateStore {
  return {
    get: async () => guildState(botPermissions),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

export function harness(): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const scheduled: Array<{ request: ActionRequest; caseId: string }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  const published: PublishedEvent[] = [];

  const dedupe = new MemoryDedupe();
  const warnings = new MemoryWarningStore();
  const roleRuns = new MemoryRoleRunStore();
  const members = new FakeMemberLister();
  const jobs: ScheduledJobCall[] = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const isAnswer = (path: string) =>
    path.startsWith('/interactions/') || path.startsWith('/webhooks/');

  const discordCalls = () => rest.calls.filter((call) => !isAnswer(call.path));

  // The first answer that carries text, not the first answer: a deferred command acknowledges
  // with an empty callback and says what happened in the followup after it.
  const replyContent = (): string | null => {
    for (const call of rest.calls) {
      if (!isAnswer(call.path)) continue;

      const body = call.body as { content?: string; data?: { content?: string } } | undefined;
      const content = body?.data?.content ?? body?.content;
      if (typeof content === 'string') return content;
    }

    return null;
  };

  const bindings = (overrides: Partial<RunOverrides>) => ({
    ...(overrides.warnings === null ? {} : { warnings: overrides.warnings ?? warnings }),
    ...(overrides.unbindRoleDeps
      ? {}
      : {
          guildState: stateStore(overrides.botPermissions ?? BOT_PERMISSIONS),
          fetchMemberRoles: async (_guildId: string, userId: string) => rolesOf(userId),
          members,
          roleRuns,
          applicationId: APPLICATION_ID,
        }),
  });

  const buildExecutor = (overrides: Partial<RunOverrides>) =>
    new DefaultActionExecutor({
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
            store: stateStore(overrides.botPermissions ?? BOT_PERMISSIONS),
            botUserId: BOT,
            fetchMemberRoles: async (_guildId, userId) => rolesOf(userId),
          },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    });

  const schedule = async (jobId: string, runAt: Date, naturalKey: string) => {
    jobs.push({ jobId, runAt, naturalKey });
    return { scheduled: true, replaced: false };
  };

  return {
    rest,
    recorder,
    warnings,
    roleRuns,
    members,
    jobs,
    scheduled,
    logs,
    published,
    discordCalls,
    replyContent,
    cases: () => recorder.recorded.filter((c) => c.kind !== 'interaction_reply'),

    async run(command, options, overrides = {}) {
      const module = createModerationModule(bindings(overrides));
      const definition = module.commands?.find((c) => c.name === command);
      if (!definition) throw new Error(`no such moderation command: ${command}`);

      const executor = buildExecutor(overrides);

      const ctx: CommandContext<ModerationConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: overrides.asOwner ? OWNER : MODERATOR,
        config: { ...moderationDefaultConfig, ...overrides.config },

        executor: executor.scoped({
          channelId: CHANNEL,
          appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        options: createCommandOptions(options),
        interaction: { id: '600000000000000001', token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),

        ...(() => {
          const actorRoleIds =
            'actorRoleIds' in overrides ? overrides.actorRoleIds : (MEMBER_ROLES[MODERATOR] ?? []);
          return actorRoleIds === undefined ? {} : { actorRoleIds };
        })(),

        schedule,

        publish: async (type, naturalKey, payload) => {
          published.push({ type, naturalKey, payload });
        },
      };

      await definition.handler(ctx);
    },

    async runJob(overrides = {}) {
      const module = createModerationModule(bindings(overrides));
      const handler = module.scheduledHandlers?.[ROLE_RUN_JOB];
      if (!handler) throw new Error('moderation registered no role-run handler');

      const executor = buildExecutor(overrides);

      await handler(undefined, {
        guildId: GUILD,
        config: { ...moderationDefaultConfig, ...overrides.config },
        executor: executor.scoped({
          channelId: CHANNEL,
          appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        schedule,
      });
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

export function roleOption(name: string, value: string): RawOption {
  return { name, type: OptionType.Role, value };
}

export function subcommand(name: string, options: RawOption[]): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function member(userId: string, roleIds: string[] = [], bot = false): GuildMemberSummary {
  return { userId, bot, roleIds };
}
