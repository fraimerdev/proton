import {
  type ActionExecutor,
  type ActionRequest,
  type ActionResult,
  type GuildMemberLister,
  type GuildMemberSummary,
  type GuildRole,
  type GuildState,
  type Logger,
  type MemberPageFailure,
  type MemberPageResult,
  type ModuleContext,
  moduleScheduleKey,
  Permissions,
  type ProtonEvent,
  type ScheduleOptions,
  type ScheduleOutcome,
} from '@proton/core';
import type { JoinrolesConfig } from '../src/config.ts';
import type { JoinRolesDeps } from '../src/listeners.ts';
import type { JoinRolesRunStore, SyncFinish } from '../src/sync/store.ts';
import {
  type LastSync,
  lastSyncSchema,
  queuedRun,
  type SyncEstimate,
  type SyncRun,
  syncEstimateSchema,
  syncRunSchema,
} from '../src/sync/view.ts';
import {
  BOT_ROLE,
  config,
  FakePendingStore,
  GUILD,
  PROTON,
  ROLE_ABOVE_BOT,
  ROLE_LOW,
  ROLE_MANAGED,
  ROLE_MID,
} from './harness.ts';

export const NOW = Date.parse('2026-09-18T12:00:00.000Z');
export const OWNER = '100000000000000009';
export const ACTOR = '100000000000000001';

export function user(n: number): string {
  return String(200000000000000000n + BigInt(n));
}

function role(id: string, position: number, permissions = 0n, managed?: boolean): GuildRole {
  return { id, permissions, position, ...(managed === undefined ? {} : { managed }) };
}

export function syncState(botPermissions: bigint = Permissions.ManageRoles): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, role(GUILD, 0)],
      [ROLE_LOW, role(ROLE_LOW, 10)],
      [ROLE_MID, role(ROLE_MID, 20)],
      [ROLE_ABOVE_BOT, role(ROLE_ABOVE_BOT, 90)],
      [ROLE_MANAGED, role(ROLE_MANAGED, 5, 0n, true)],
      [BOT_ROLE, role(BOT_ROLE, 50, botPermissions)],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(),
    memberCount: 5000,
    updatedAt: 0,
  };
}

export function summary(
  userId: string,
  roleIds: string[] = [],
  options: { bot?: boolean; pending?: boolean } = {},
): GuildMemberSummary {
  return { userId, bot: options.bot ?? false, pending: options.pending ?? false, roleIds };
}

export class FakeLister implements GuildMemberLister {
  members: GuildMemberSummary[] = [];
  readonly failures: MemberPageFailure[] = [];
  readonly asked: string[] = [];
  throws: Error | null = null;

  async list(_guildId: string, after: string, limit: number): Promise<MemberPageResult> {
    this.asked.push(after);
    if (this.throws) throw this.throws;

    const failure = this.failures.shift();
    if (failure) return failure;

    const page = this.members
      .filter((member) => BigInt(member.userId) > BigInt(after))
      .sort((a, b) => (BigInt(a.userId) < BigInt(b.userId) ? -1 : 1))
      .slice(0, limit);

    const last = page.at(-1);
    return { members: page, next: page.length < limit || !last ? null : last.userId };
  }
}

function roundTrip<T>(value: T, schema: { parse(input: unknown): T }): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

export class MemoryRunStore implements JoinRolesRunStore {
  readonly runs = new Map<string, string>();
  readonly lasts = new Map<string, string>();
  readonly estimates = new Map<string, string>();

  async get(guildId: string): Promise<SyncRun | null> {
    const raw = this.runs.get(guildId);
    return raw === undefined ? null : syncRunSchema.parse(JSON.parse(raw));
  }

  async claim(run: SyncRun): Promise<boolean> {
    if (this.runs.has(run.guildId)) return false;
    this.runs.set(run.guildId, JSON.stringify(run));
    return true;
  }

  async putIfCurrent(run: SyncRun): Promise<boolean> {
    if ((await this.get(run.guildId))?.runId !== run.runId) return false;
    this.runs.set(run.guildId, JSON.stringify(run));
    return true;
  }

  async clear(guildId: string, runId: string): Promise<boolean> {
    if ((await this.get(guildId))?.runId !== runId) return false;
    this.runs.delete(guildId);
    return true;
  }

  async finish(guildId: string, runId: string, result: SyncFinish): Promise<boolean> {
    if ((await this.get(guildId))?.runId !== runId) return false;
    if (result.last) this.lasts.set(guildId, JSON.stringify(result.last));
    if (result.estimate) this.estimates.set(guildId, JSON.stringify(result.estimate));
    this.runs.delete(guildId);
    return true;
  }

  async last(guildId: string): Promise<LastSync | null> {
    const raw = this.lasts.get(guildId);
    return raw === undefined ? null : roundTrip(JSON.parse(raw), lastSyncSchema);
  }

  async estimate(guildId: string): Promise<SyncEstimate | null> {
    const raw = this.estimates.get(guildId);
    return raw === undefined ? null : roundTrip(JSON.parse(raw), syncEstimateSchema);
  }

  readonly autosync = new Map<string, number>();

  async autosyncAt(guildId: string): Promise<number | null> {
    return this.autosync.get(guildId) ?? null;
  }

  async setAutosyncAt(guildId: string, at: number): Promise<void> {
    this.autosync.set(guildId, at);
  }

  seed(run: SyncRun): void {
    this.runs.set(run.guildId, JSON.stringify(run));
  }
}

export class ProgrammableExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  readonly applied: ActionRequest[] = [];
  readonly scopes: unknown[] = [];
  respond: (request: ActionRequest) => ActionResult | undefined = () => undefined;
  beforeEach: (request: ActionRequest) => Promise<void> = async () => {};

  readonly #claimed = new Set<string>();

  scoped(hints: unknown): ActionExecutor {
    this.scopes.push(hints);
    return { execute: (request) => this.execute(request) };
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    await this.beforeEach(request);

    if (this.#claimed.has(request.idempotencyKey)) return { status: 'skipped_duplicate' };

    const answer = this.respond(request);
    if (answer) return answer;

    this.#claimed.add(request.idempotencyKey);
    this.applied.push(request);
    return { status: 'executed' };
  }

  targets(): string[] {
    return this.requests.map((request) => request.targetId ?? '');
  }
}

export interface Booking {
  jobId: string;
  runAt: number;
  naturalKey: string;
  data: unknown;
  replace: boolean;
}

export class FakeScheduler {
  readonly calls: Booking[] = [];
  readonly table = new Map<string, Booking>();
  readonly cancelled: string[] = [];

  schedule = async (
    jobId: string,
    runAt: Date,
    naturalKey: string,
    data?: unknown,
    options?: ScheduleOptions,
  ): Promise<ScheduleOutcome> => {
    const booking: Booking = {
      jobId,
      runAt: runAt.getTime(),
      naturalKey,
      data: data === undefined ? undefined : JSON.parse(JSON.stringify(data)),
      replace: options?.replace === true,
    };
    this.calls.push(booking);

    const key = moduleScheduleKey('joinroles', jobId, GUILD, naturalKey);
    const existing = this.table.has(key);
    if (existing && !booking.replace) return { scheduled: false, replaced: false };

    this.table.set(key, booking);
    return { scheduled: true, replaced: existing };
  };

  cancel = async (jobId: string, naturalKey: string): Promise<void> => {
    const key = moduleScheduleKey('joinroles', jobId, GUILD, naturalKey);
    this.cancelled.push(key);
    this.table.delete(key);
  };

  booked(jobId: string): Booking | undefined {
    return [...this.table.values()].find((booking) => booking.jobId === jobId);
  }

  forget(): void {
    this.table.clear();
    this.calls.length = 0;
  }
}

export function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => {
    lines.push(message);
  };
  return { lines, logger: { info: push, warn: push, error: push } };
}

export interface SyncHarness {
  runs: MemoryRunStore;
  lister: FakeLister;
  executor: ProgrammableExecutor;
  scheduler: FakeScheduler;
  pending: FakePendingStore;
  lines: string[];
  state: { current: GuildState | null };
  clock: { now: number };
  deps: JoinRolesDeps;
  ctx(
    overrides?: Partial<JoinrolesConfig>,
    options?: { schedule?: boolean },
  ): ModuleContext<JoinrolesConfig>;
  queue(overrides?: Partial<Parameters<typeof queuedRun>[0]>): SyncRun;
}

export function syncHarness(options: { pending?: boolean } = {}): SyncHarness {
  const runs = new MemoryRunStore();
  const lister = new FakeLister();
  const executor = new ProgrammableExecutor();
  const scheduler = new FakeScheduler();
  const pending = new FakePendingStore();
  const { logger, lines } = recordingLogger();
  const state: { current: GuildState | null } = { current: syncState() };
  const clock = { now: NOW };

  const deps: JoinRolesDeps = {
    runs,
    members: lister,
    guildState: { get: async () => state.current },
    botUserId: PROTON,
    now: () => clock.now,
    ...(options.pending === false ? {} : { pending }),
  };

  return {
    runs,
    lister,
    executor,
    scheduler,
    pending,
    lines,
    state,
    clock,
    deps,
    ctx(overrides = {}, ctxOptions = {}) {
      return {
        guildId: GUILD,
        config: config(overrides),
        executor,
        logger,
        ...(ctxOptions.schedule === false
          ? {}
          : { schedule: scheduler.schedule, cancel: scheduler.cancel }),
      };
    },
    queue(overrides = {}) {
      const run = queuedRun({
        runId: 'run-1',
        guildId: GUILD,
        kind: 'sync',
        trigger: 'dashboard',
        actorId: ACTOR,
        now: clock.now,
        ...overrides,
      });
      runs.seed(run);
      return run;
    },
  };
}

export function serviceEvent(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return { id: `${type}:1`, type, guildId: GUILD, occurredAt: NOW, payload };
}
