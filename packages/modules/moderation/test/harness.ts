import {
  type ActionExecutor,
  type ActionKind,
  type ActionRequest,
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  type CommandDefinition,
  type CommandLabeler,
  type ContextMenuDefinition,
  type ContextMenuType,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type EntitlementTier,
  type EventListener,
  type EventType,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_MODAL,
  INTERACTION_CALLBACK_UPDATE_MESSAGE,
  isScopedActionExecutor,
  type Logger,
  type ModuleContext,
  newCaseId,
  newId,
  OptionType,
  Permissions,
  type PrecheckInput,
  type ProtonCustomId,
  type ProtonEvent,
  parseCustomId,
  type RawOption,
  type ResolveContextHints,
  type ResolvedData,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  readComponentInteraction,
  readModalInteraction,
  readResolved,
  resolvePrecheckContext,
  resolvePrivateReply,
  type ScheduledHandler,
  type ScheduleOptions,
  type ScheduleOutcome,
  type ScopedActionExecutor,
  STATUS_ERROR_COLOUR,
  STATUS_SUCCESS_COLOUR,
  subcommandPath,
  UndeclaredScheduleError,
} from '@proton/core';
import { ApplicationCommandType } from 'discord-api-types/v10';
import type { z } from 'zod';
import type { ModerationConfig } from '../src/config.ts';
import { moderationConfigSchema, moderationDefaultConfig } from '../src/config.ts';
import type { MemberLookup, ModerationDeps } from '../src/deps.ts';
import { createModerationModule, ROLE_RUN_JOB, ROLE_RUN_KEY } from '../src/index.ts';
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

export const REPORTER = '400000000000000003';

export const MESSAGE = '1400000000000000001';

export function dmChannelFor(userId: string): string {
  return `9${userId}`;
}

function recipientOf(channelId: string): string | null {
  return /^9([1-9]\d{17,18})$/.exec(channelId)?.[1] ?? null;
}

export const DM_CHANNEL = dmChannelFor(MEMBER);

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

export function rolesHeldBy(userId: string): string[] {
  return rolesOf(userId) ?? [];
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
  readonly #claimed = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  async claim(key: string, ttlMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    if (await this.has(key)) return false;
    this.#claimed.set(key, this.#now() + ttlMs);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return (this.#claimed.get(key) ?? Number.NEGATIVE_INFINITY) > this.#now();
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

export type RestMatch = string | RegExp | ((call: RestRequestOptions) => boolean);

export type RestAnswer = RestResponse | ((call: RestRequestOptions) => RestResponse);

interface Responder {
  match: RestMatch;
  answer: RestAnswer;
  times: number;
}

export function discordError(status: number, code: number, message: string): RestResponse {
  return { status, body: { code, message } };
}

const SEND_PATH = /^\/channels\/(\d+)\/messages$/;
const MESSAGE_PATH = /^\/channels\/(\d+)\/messages\/(\d+)$/;
const OPEN_DM_PATH = '/users/@me/channels';

function matches(match: RestMatch, call: RestRequestOptions): boolean {
  if (typeof match === 'function') return match(call);

  const line = `${call.method} ${call.path}`;
  return typeof match === 'string' ? line.includes(match) : match.test(line);
}

export class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  readonly responses: RestResponse[] = [];

  readonly #untouched: RestResponse = { status: 200, body: {} };
  response: RestResponse = this.#untouched;

  readonly #responders: Responder[] = [];
  #nextId = 1_700_000_000_000_000_001n;

  respond(match: RestMatch, answer: RestAnswer, options: { times?: number } = {}): void {
    this.#responders.push({ match, answer, times: options.times ?? Number.POSITIVE_INFINITY });
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    const response = this.#answer(options);
    this.responses.push(response);
    return response;
  }

  #answer(call: RestRequestOptions): RestResponse {
    const responder = this.#responders.findLast(
      (candidate) => candidate.times > 0 && matches(candidate.match, call),
    );
    if (responder) {
      responder.times -= 1;
      return typeof responder.answer === 'function' ? responder.answer(call) : responder.answer;
    }

    // An assigned response answers every call, as it always has, ahead of the shaped defaults.
    if (this.response !== this.#untouched) return this.response;

    if (call.method !== 'POST') return { status: 200, body: {} };

    if (call.path === OPEN_DM_PATH) {
      const recipient = (call.body as { recipient_id?: unknown } | undefined)?.recipient_id;
      const id = typeof recipient === 'string' ? dmChannelFor(recipient) : DM_CHANNEL;
      return { status: 200, body: { id, type: 1 } };
    }

    const sent = SEND_PATH.exec(call.path);
    if (sent) return { status: 200, body: { id: this.#mint(), channel_id: sent[1] } };

    if (call.path.startsWith('/webhooks/')) return { status: 200, body: { id: this.#mint() } };

    return { status: 200, body: {} };
  }

  #mint(): string {
    const id = this.#nextId;
    this.#nextId += 1n;
    return String(id);
  }
}

export interface PublishedEvent {
  type: string;
  naturalKey: string;
  payload: unknown;
}

export interface AnswerMessage {
  content?: string;
  embeds?: Array<{ description?: string; color?: number }>;
}

export interface SentEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export interface SentMessage {
  content?: string;
  embeds?: SentEmbed[];
  components?: Array<Record<string, unknown>>;
  flags?: number;
  allowed_mentions?: { parse?: string[]; roles?: string[]; users?: string[] };
  [key: string]: unknown;
}

export interface MessageRef {
  channelId: string;
  messageId: string;
}

export interface EditedMessage extends MessageRef {
  message: SentMessage;
}

export interface DirectMessage {
  userId: string;
  channelId: string;
  message: SentMessage;
  status: number;
}

export type StatusTone = 'success' | 'error' | 'neutral';

export interface ScheduledCall {
  jobId: string;
  runAt: Date;
  naturalKey: string;
  data: unknown;
  options: ScheduleOptions | undefined;
  outcome: ScheduleOutcome;
}

export interface HarnessOptions {
  now?: number;
  deps?: ModerationDeps;
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
  replyMessage(): AnswerMessage | null;
  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;

  now(): number;
  advance(ms: number): void;

  requests: ActionRequest[];
  publishedEvents: ProtonEvent[];
  scheduledJobs: ScheduledCall[];
  cancelled: Array<{ jobId: string; naturalKey: string }>;
  pendingJobs(): ScheduledCall[];

  context(overrides?: Partial<RunOverrides>): ModuleContext<ModerationConfig>;
  listen(
    event: ProtonEvent,
    listeners?: readonly EventListener<ModerationConfig>[],
    overrides?: Partial<RunOverrides>,
  ): Promise<number>;
  command(event: ProtonEvent, overrides?: Partial<RunOverrides>): Promise<boolean>;
  job(jobId: string, data?: unknown, overrides?: Partial<JobOverrides>): Promise<boolean>;
  runDue(overrides?: Partial<RunOverrides>): Promise<number>;

  replies(): SentMessage[];
  followUps(): SentMessage[];
  modalsOpened(): SentMessage[];
  callbackTypes(): number[];
  sentIn(channelId: string): SentMessage[];
  edits(): EditedMessage[];
  deletes(): MessageRef[];
  dms(): DirectMessage[];
  statusOf(message: unknown): StatusTone;
  keysUsed(): string[];
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

  userId: string;
  channelId: string;
  actorPermissions: bigint;
  resolved: ResolvedData;
  guildState: GuildState;

  configInput: z.input<typeof moderationConfigSchema>;
  deps: ModerationDeps;
  tier: EntitlementTier;
  moduleEnabled: boolean;

  // The command's "Respond privately" setting from the Commands page; null follows its default.
  replyPreference: boolean | null;

  // Present, it replaces what the worker would resolve — undefined is a worker that set none.
  privateReply: boolean | undefined;

  // How this server shows Proton's commands; absent is a worker with no label source.
  commandLabel: CommandLabeler;

  actionKinds: ActionKind[];
  emits: EventType[];
  schedules: string[];

  commands: CommandDefinition<ModerationConfig>[];
  contextMenus: ContextMenuDefinition<ModerationConfig>[];
  handlers: Record<string, ScheduledHandler<ModerationConfig>>;
  directInteractionGuild: (customId: ProtonCustomId) => string | null;
}

export interface JobOverrides extends RunOverrides {
  naturalKey: string;
}

const SNOWFLAKE = /^\d{17,20}$/;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function bigintOf(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function privateReplyOf(
  command: CommandDefinition<ModerationConfig>,
  config: ModerationConfig,
  raw: readonly RawOption[],
  overrides: Partial<RunOverrides>,
): { privateReply?: boolean } {
  if ('privateReply' in overrides) {
    return overrides.privateReply === undefined ? {} : { privateReply: overrides.privateReply };
  }
  if (!command.reply) return {};

  const preference = overrides.replyPreference ?? null;
  return {
    privateReply: resolvePrivateReply(command.reply, config, subcommandPath(raw), preference),
  };
}

function labelsOf(overrides: Partial<RunOverrides>): { commandLabel?: CommandLabeler } {
  return overrides.commandLabel ? { commandLabel: overrides.commandLabel } : {};
}

function guarded(
  moduleId: string,
  executor: ActionExecutor,
  kinds: ReadonlySet<ActionKind>,
  requests: ActionRequest[],
): ScopedActionExecutor {
  const allow = (request: ActionRequest): void => {
    if (!kinds.has(request.kind)) {
      throw new Error(
        `The '${moduleId}' module tried to execute a '${request.kind}' action, which it does not ` +
          "declare in its manifest's `actionKinds` array, so the worker would refuse it.",
      );
    }
  };
  const precheck = executor.precheck?.bind(executor);

  const wrapped: ScopedActionExecutor = {
    execute(request) {
      allow(request);
      requests.push(request);
      return executor.execute(request);
    },

    ...(precheck
      ? {
          precheck(request: ActionRequest) {
            allow(request);
            return precheck(request);
          },
        }
      : {}),

    scoped(hints) {
      if (!isScopedActionExecutor(executor)) return wrapped;
      return guarded(moduleId, executor.scoped(hints), kinds, requests);
    },
  };

  return wrapped;
}

function directGuildOf(
  moduleId: string,
  event: ProtonEvent,
  hook: (customId: ProtonCustomId) => string | null,
): string | null {
  const read =
    event.type === 'interaction.component'
      ? readComponentInteraction(event)
      : event.type === 'interaction.modal'
        ? readModalInteraction(event)
        : null;

  const parsed = parseCustomId(read?.customId);
  if (!parsed || parsed.moduleId !== moduleId) return null;

  const guildId = hook(parsed);
  return guildId && SNOWFLAKE.test(guildId) ? guildId : null;
}

function stateStore(botPermissions: bigint, state?: GuildState): GuildStateStore {
  return {
    get: async () => state ?? guildState(botPermissions),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };
}

export function baseGuildState(botPermissions: bigint = BOT_PERMISSIONS): GuildState {
  return guildState(botPermissions);
}

export function harness(options: HarnessOptions = {}): Harness {
  let clock = options.now ?? Date.now();
  const now = (): number => clock;

  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const scheduled: Array<{ request: ActionRequest; caseId: string }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  const published: PublishedEvent[] = [];
  const publishedEvents: ProtonEvent[] = [];
  const requests: ActionRequest[] = [];

  const dedupe = new MemoryDedupe(now);
  const warnings = new MemoryWarningStore();
  const roleRuns = new MemoryRoleRunStore();
  const members = new FakeMemberLister();
  const jobs: ScheduledJobCall[] = [];
  const scheduledJobs: ScheduledCall[] = [];
  const cancelled: Array<{ jobId: string; naturalKey: string }> = [];
  const pending = new Map<string, ScheduledCall>();
  const pendingKey = (jobId: string, naturalKey: string): string =>
    JSON.stringify([jobId, naturalKey]);

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const isAnswer = (path: string) =>
    path.startsWith('/interactions/') || path.startsWith('/webhooks/');

  const discordCalls = () => rest.calls.filter((call) => !isAnswer(call.path));

  const replyMessage = (): AnswerMessage | null => {
    for (const call of rest.calls) {
      if (!isAnswer(call.path)) continue;

      // A callback nests its message under `data`; a webhook followup carries it at the top level.
      const body = call.body as (AnswerMessage & { data?: AnswerMessage }) | undefined;
      const message = body?.data ?? body;
      if (message?.content || message?.embeds?.[0]) return message;
    }

    return null;
  };

  // The first answer that carries text, not the first answer: a deferred command acknowledges
  // with an empty callback and says what happened in the followup after it.
  const replyContent = (): string | null => {
    const message = replyMessage();
    return message?.content || message?.embeds?.[0]?.description || null;
  };

  const bindings = (overrides: Partial<RunOverrides>) => ({
    ...(overrides.warnings === null ? {} : { warnings: overrides.warnings ?? warnings }),
    ...(overrides.unbindRoleDeps
      ? {}
      : {
          guildState: stateStore(overrides.botPermissions ?? BOT_PERMISSIONS, overrides.guildState),
          fetchMemberRoles: async (_guildId: string, userId: string) => rolesOf(userId),
          lookupMember: async (_guildId: string, userId: string): Promise<MemberLookup> => {
            const roleIds = rolesOf(userId);
            return roleIds === null
              ? { state: 'absent' }
              : { state: 'member', roleIds, timeoutUntil: null, joinedAt: null };
          },
          members,
          roleRuns,
          applicationId: APPLICATION_ID,
        }),
    now,
    botUserId: BOT,
    ...options.deps,
    ...overrides.deps,
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
            store: stateStore(overrides.botPermissions ?? BOT_PERMISSIONS, overrides.guildState),
            botUserId: BOT,
            fetchMemberRoles: async (_guildId, userId) => rolesOf(userId),
          },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    });

  const configFor = (overrides: Partial<RunOverrides>): ModerationConfig => ({
    ...(overrides.configInput === undefined
      ? moderationDefaultConfig
      : moderationConfigSchema.parse(overrides.configInput)),
    ...overrides.config,
  });

  const runtimeOf = (overrides: Partial<RunOverrides>) => {
    const module = createModerationModule(bindings(overrides));

    const kinds = new Set<ActionKind>(overrides.actionKinds ?? module.actionKinds ?? []);
    const emits = new Set<EventType>(overrides.emits ?? module.emits ?? []);
    const schedules = new Set<string>(overrides.schedules ?? module.schedules ?? []);

    const declared = (jobId: string, verb: string): void => {
      if (!schedules.has(jobId)) {
        throw new UndeclaredScheduleError(
          module.id,
          jobId,
          `it tried to ${verb} it but does not declare it in \`schedules\`.`,
        );
      }
    };

    const schedule = async (
      jobId: string,
      runAt: Date,
      naturalKey: string,
      data?: unknown,
      scheduleOptions?: ScheduleOptions,
    ): Promise<ScheduleOutcome> => {
      declared(jobId, 'schedule');

      const key = pendingKey(jobId, naturalKey);
      const existing = pending.has(key);
      const outcome: ScheduleOutcome =
        existing && !scheduleOptions?.replace
          ? { scheduled: false, replaced: false }
          : { scheduled: true, replaced: existing };

      const call: ScheduledCall = {
        jobId,
        runAt,
        naturalKey,
        data,
        options: scheduleOptions,
        outcome,
      };
      jobs.push({ jobId, runAt, naturalKey });
      scheduledJobs.push(call);
      if (outcome.scheduled) pending.set(key, call);

      return outcome;
    };

    const cancel = async (jobId: string, naturalKey: string): Promise<void> => {
      declared(jobId, 'cancel');
      pending.delete(pendingKey(jobId, naturalKey));
      cancelled.push({ jobId, naturalKey });
    };

    const publisher =
      (guildId: string) =>
      async (type: EventType, naturalKey: string, payload: unknown): Promise<void> => {
        if (!emits.has(type)) {
          throw new Error(
            `The '${module.id}' module tried to publish '${type}', which it does not declare in ` +
              "its manifest's `emits` array, so the worker would refuse it.",
          );
        }

        published.push({ type, naturalKey, payload });
        publishedEvents.push({
          id: `${type}:${guildId}:${naturalKey}`,
          type,
          guildId,
          occurredAt: clock,
          payload,
        });
      };

    const guard = (executor: ActionExecutor): ScopedActionExecutor =>
      guarded(module.id, executor, kinds, requests);

    return { module, guard, schedule, cancel, publisher };
  };

  type Runtime = ReturnType<typeof runtimeOf>;

  const moduleContext = (
    runtime: Runtime,
    guildId: string,
    overrides: Partial<RunOverrides>,
  ): ModuleContext<ModerationConfig> => ({
    guildId,
    config: configFor(overrides),
    tier: overrides.tier ?? 'free',
    executor: runtime.guard(buildExecutor(overrides)),
    logger,
    publish: runtime.publisher(guildId),
    schedule: runtime.schedule,
    cancel: runtime.cancel,
    ...labelsOf(overrides),
  });

  const callbacks = () =>
    rest.calls
      .filter((call) => call.path.startsWith('/interactions/'))
      .map((call) => (call.body ?? {}) as { type?: number; data?: SentMessage });

  const bodyOf = (call: RestRequestOptions): SentMessage => (call.body ?? {}) as SentMessage;

  const onMessages = (method: string) =>
    rest.calls.flatMap((call) => {
      const found = call.method === method ? MESSAGE_PATH.exec(call.path) : null;
      return found?.[1] && found[2] ? [{ call, channelId: found[1], messageId: found[2] }] : [];
    });

  const dms = (): DirectMessage[] => {
    const opened = new Map<string, string>();
    const sent: DirectMessage[] = [];

    rest.calls.forEach((call, index) => {
      const response = rest.responses[index];
      if (call.method !== 'POST' || !response) return;

      if (call.path === OPEN_DM_PATH) {
        const channelId = (response.body as { id?: unknown } | undefined)?.id;
        const userId = (call.body as { recipient_id?: unknown } | undefined)?.recipient_id;
        if (response.status < 400 && typeof channelId === 'string' && typeof userId === 'string') {
          opened.set(channelId, userId);
        }
        return;
      }

      const channelId = SEND_PATH.exec(call.path)?.[1];
      const userId = channelId ? (opened.get(channelId) ?? recipientOf(channelId)) : null;
      if (channelId && userId) {
        sent.push({ userId, channelId, message: bodyOf(call), status: response.status });
      }
    });

    return sent;
  };

  const statusOf = (message: unknown): StatusTone => {
    const body = (message ?? {}) as SentMessage;
    const inner = (
      typeof body.data === 'object' && body.data !== null ? body.data : body
    ) as SentMessage;
    const color = inner.embeds?.[0]?.color;

    if (color === STATUS_SUCCESS_COLOUR) return 'success';
    if (color === STATUS_ERROR_COLOUR) return 'error';
    return 'neutral';
  };

  const job = async (
    jobId: string,
    data?: unknown,
    overrides: Partial<JobOverrides> = {},
  ): Promise<boolean> => {
    const runtime = runtimeOf(overrides);
    const handlers = overrides.handlers ?? runtime.module.scheduledHandlers ?? {};
    const handler = Object.hasOwn(handlers, jobId) ? handlers[jobId] : undefined;
    if (!handler) throw new Error(`moderation has no scheduled handler for '${jobId}'`);

    if (overrides.naturalKey !== undefined) {
      pending.delete(pendingKey(jobId, overrides.naturalKey));
    }

    if (overrides.moduleEnabled === false || !configFor(overrides).enabled) return false;

    await handler(data, moduleContext(runtime, GUILD, overrides));
    return true;
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
    replyMessage,
    cases: () => recorder.recorded.filter((c) => c.kind !== 'interaction_reply'),

    now,
    advance: (ms) => {
      clock += ms;
    },

    requests,
    publishedEvents,
    scheduledJobs,
    cancelled,
    pendingJobs: () => [...pending.values()],

    async run(command, options, overrides = {}) {
      const runtime = runtimeOf(overrides);
      const definition = (overrides.commands ?? runtime.module.commands)?.find(
        (c) => c.name === command,
      );
      if (!definition) throw new Error(`no such moderation command: ${command}`);

      const channelId = overrides.channelId ?? CHANNEL;
      const userId = overrides.asOwner ? OWNER : (overrides.userId ?? MODERATOR);
      const config = configFor(overrides);

      const ctx: CommandContext<ModerationConfig> = {
        guildId: GUILD,
        channelId,
        userId,
        config,
        ...(overrides.tier ? { tier: overrides.tier } : {}),

        executor: runtime.guard(
          buildExecutor(overrides).scoped({
            channelId,
            appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
          }),
        ),
        logger,
        options: createCommandOptions(options, overrides.resolved),
        ...(overrides.resolved ? { resolved: overrides.resolved } : {}),
        interaction: { id: '600000000000000001', token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
        ...privateReplyOf(definition, config, options, overrides),

        ...(() => {
          const fallback =
            overrides.userId && !overrides.asOwner
              ? rolesHeldBy(overrides.userId)
              : (MEMBER_ROLES[MODERATOR] ?? []);
          const actorRoleIds = 'actorRoleIds' in overrides ? overrides.actorRoleIds : fallback;
          return actorRoleIds === undefined ? {} : { actorRoleIds };
        })(),
        ...(overrides.actorPermissions === undefined
          ? {}
          : { actorPermissions: overrides.actorPermissions }),

        schedule: runtime.schedule,
        cancel: runtime.cancel,
        publish: runtime.publisher(GUILD),
        ...labelsOf(overrides),
      };

      await definition.handler(ctx);
    },

    async runJob(overrides = {}) {
      const runtime = runtimeOf(overrides);
      const handler = runtime.module.scheduledHandlers?.[ROLE_RUN_JOB];
      if (!handler) throw new Error('moderation registered no role-run handler');

      pending.delete(pendingKey(ROLE_RUN_JOB, ROLE_RUN_KEY));

      await handler(undefined, {
        guildId: GUILD,
        config: configFor(overrides),
        executor: runtime.guard(
          buildExecutor(overrides).scoped({
            channelId: CHANNEL,
            appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
          }),
        ),
        logger,
        publish: runtime.publisher(GUILD),
        schedule: runtime.schedule,
        cancel: runtime.cancel,
        ...labelsOf(overrides),
      });
    },

    context: (overrides = {}) => moduleContext(runtimeOf(overrides), GUILD, overrides),

    async listen(event, listeners, overrides = {}) {
      const runtime = runtimeOf(overrides);
      const hook =
        overrides.directInteractionGuild ??
        ((customId: ProtonCustomId) => runtime.module.directInteractionGuild?.(customId) ?? null);

      const guildId = event.guildId ?? directGuildOf(runtime.module.id, event, hook);
      if (guildId === null) return 0;

      const routed = event.guildId === null ? { ...event, guildId } : event;
      const matching = (listeners ?? runtime.module.listeners ?? []).filter((listener) =>
        listener.types.includes(routed.type),
      );
      if (matching.length === 0) return 0;

      if (overrides.moduleEnabled === false && routed.type !== 'proton.config_changed') return 0;

      const ctx = moduleContext(runtime, guildId, overrides);
      for (const listener of matching) {
        await listener.handler(routed, ctx);
      }

      return matching.length;
    },

    async command(event, overrides = {}) {
      const d = recordOf(event.payload);
      const data = recordOf(d.data);
      const member = recordOf(d.member);
      const user = recordOf(d.member ? member.user : d.user);

      const name = stringOf(data.name);
      const guildId = stringOf(d.guild_id);
      const channelId = stringOf(d.channel_id);
      const interactionId = stringOf(d.id);
      const token = stringOf(d.token);
      const userId = stringOf(user.id);
      const targetId = stringOf(data.target_id);
      const commandType: ContextMenuType | null =
        data.type === ApplicationCommandType.User
          ? 'user'
          : data.type === ApplicationCommandType.Message
            ? 'message'
            : null;

      if (
        event.type !== 'interaction.command' ||
        !name ||
        !guildId ||
        !channelId ||
        !interactionId ||
        !token ||
        !userId ||
        (commandType && !targetId)
      ) {
        throw new Error(`${event.id} is not an interaction.command event the worker would run`);
      }

      const runtime = runtimeOf(overrides);
      const menu = commandType
        ? (overrides.contextMenus ?? runtime.module.contextMenus ?? []).find(
            (candidate) => candidate.name === name && candidate.type === commandType,
          )
        : undefined;
      const command = commandType
        ? undefined
        : (overrides.commands ?? runtime.module.commands ?? []).find(
            (candidate) => candidate.name === name,
          );
      if (!menu && !command) {
        throw new Error(
          `moderation has no ${commandType ? `${commandType} context menu` : 'command'} '${name}'`,
        );
      }

      const config = configFor(overrides);
      if (overrides.moduleEnabled === false || !config.enabled) return false;

      const actorPermissions = bigintOf(member.permissions);
      const actorNick = member.nick === null ? null : (stringOf(member.nick) ?? undefined);
      const actorDisplayName = stringOf(user.global_name) ?? stringOf(user.username);
      const applicationId = stringOf(d.application_id);
      const resolved = readResolved(d);

      const ctx = {
        guildId,
        channelId,
        userId,
        actorRoleIds: Array.isArray(member.roles)
          ? member.roles.filter((role): role is string => typeof role === 'string')
          : [],
        ...(actorPermissions === undefined ? {} : { actorPermissions }),
        ...(actorNick === undefined ? {} : { actorNick }),
        ...(actorDisplayName === null ? {} : { actorDisplayName }),
        resolved,
        config,
        tier: overrides.tier ?? 'free',
        executor: runtime.guard(
          buildExecutor(overrides).scoped({
            channelId,
            appPermissions: bigintOf(d.app_permissions),
          }),
        ),
        logger,
        publish: runtime.publisher(guildId),
        schedule: runtime.schedule,
        cancel: runtime.cancel,
        interaction: { id: interactionId, token },
        ...(applicationId ? { applicationId } : {}),
        idempotencyKey: event.id,
        ...labelsOf(overrides),
      };

      if (menu && commandType && targetId) {
        await menu.handler({ ...ctx, commandType, targetId });
      } else if (command) {
        const raw = Array.isArray(data.options) ? (data.options as RawOption[]) : [];
        await command.handler({
          ...ctx,
          options: createCommandOptions(raw, resolved),
          ...privateReplyOf(command, config, raw, overrides),
        });
      }

      return true;
    },

    job,

    async runDue(overrides = {}) {
      const due = [...pending.values()]
        .filter((call) => call.runAt.getTime() <= clock)
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());

      for (const call of due) {
        await job(call.jobId, call.data, { ...overrides, naturalKey: call.naturalKey });
      }

      return due.length;
    },

    replies: () =>
      callbacks()
        .filter(
          (body) =>
            body.type === INTERACTION_CALLBACK_CHANNEL_MESSAGE ||
            body.type === INTERACTION_CALLBACK_UPDATE_MESSAGE,
        )
        .map((body) => body.data ?? {}),

    followUps: () =>
      rest.calls
        .filter((call) => call.method === 'POST' && call.path.startsWith('/webhooks/'))
        .map(bodyOf),

    modalsOpened: () =>
      callbacks()
        .filter((body) => body.type === INTERACTION_CALLBACK_MODAL)
        .map((body) => body.data ?? {}),

    callbackTypes: () =>
      callbacks()
        .map((body) => body.type)
        .filter((type): type is number => typeof type === 'number'),

    sentIn: (channelId) =>
      rest.calls
        .filter((call) => call.method === 'POST' && call.path === `/channels/${channelId}/messages`)
        .map(bodyOf),

    edits: () =>
      onMessages('PATCH').map(({ call, channelId, messageId }) => ({
        channelId,
        messageId,
        message: bodyOf(call),
      })),

    deletes: () =>
      onMessages('DELETE').map(({ channelId, messageId }) => ({ channelId, messageId })),

    dms,
    statusOf,
    keysUsed: () => requests.map((request) => request.idempotencyKey),
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
  return { userId, bot, pending: false, roleIds };
}
