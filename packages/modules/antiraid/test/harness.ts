import {
  type CaseInput,
  type CaseRecorder,
  type DedupeStore,
  DefaultActionExecutor,
  DISCORD_EPOCH_MS,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  Permissions,
  type ProtonEvent,
  type RateWindowHit,
  type RateWindowResult,
  type RateWindowStore,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  rateWindowKey,
  resolvePrecheckContext,
} from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { type AntiraidConfig, antiraidDefaultConfig } from '../src/config.ts';
import { createAntiraidModule } from '../src/index.ts';

/** The guild the recorded GUILD_MEMBER_ADD fixture belongs to. */
export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const ALERT_CHANNEL = '500000000000000001';
export const VERIFY_ROLE = '410000000000000002';
export const QUARANTINE_ROLE = '410000000000000003';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';
/** Above the bot — a member holding it must fail the hierarchy precheck (I8). */
export const HIGH_ROLE = '410000000000000009';

/** Everything the response ladder plus the alert needs. */
export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.ManageRoles |
  Permissions.KickMembers;

function roles(botPermissions: bigint): Map<string, GuildRole> {
  return new Map<string, GuildRole>([
    [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
    [VERIFY_ROLE, { id: VERIFY_ROLE, permissions: 0n, position: 2 }],
    [QUARANTINE_ROLE, { id: QUARANTINE_ROLE, permissions: 0n, position: 3 }],
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
    channels: new Map([[ALERT_CHANNEL, { id: ALERT_CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
  };
}

/**
 * The sliding window, in memory.
 *
 * A line-for-line mirror of `RATE_WINDOW_LUA`: trim by score, insert only if the
 * member is new (NX), count. The real one is exercised against Redis in
 * `packages/core/test/rules/rate-window.integration.test.ts` and again, through
 * this module, in `join-rate.integration.test.ts` — this copy exists so the
 * behavioural tests below can run without Docker, not to stand in for either.
 */
export class MemoryRateWindow implements RateWindowStore {
  readonly #windows = new Map<string, Map<string, number>>();

  async hit(input: RateWindowHit): Promise<RateWindowResult> {
    const key = rateWindowKey(input.guildId, input.ruleId, input.actorId);
    const window = this.#windows.get(key) ?? new Map<string, number>();
    this.#windows.set(key, window);

    const cutoff = input.now - input.windowMs;
    for (const [member, score] of window) {
      if (score <= cutoff) window.delete(member);
    }

    const added = !window.has(input.member);
    if (added) window.set(input.member, input.now);

    const count = window.size;
    return { count, tripped: added && count === input.limit };
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

/**
 * A Discord id for an account created at `createdAt`.
 *
 * The inverse of `snowflakeCreatedAt`, so the account-age heuristic is exercised
 * through the same arithmetic production uses rather than against a hand-written
 * literal whose age silently drifts as the test suite ages.
 */
export function accountId(createdAt: number): string {
  return String((BigInt(Math.trunc(createdAt)) - BigInt(DISCORD_EPOCH_MS)) << 22n);
}

export interface JoinInput {
  /** Defaults to an account created a year before `joinedAt`. */
  userId?: string;
  /** ms since epoch; becomes the dispatch's `joined_at` and the event's clock. */
  joinedAt: number;
  /** Discord sends null for an account that never set one. */
  avatar?: string | null;
  bot?: boolean;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Build a `member.joined` event from the recorded GUILD_MEMBER_ADD fixture.
 *
 * The payload is the real recorded shape (I11); the id and `occurredAt` are
 * derived exactly as `apps/gateway`'s normaliser derives them, rather than by
 * importing the gateway — a module package must not depend on an app.
 */
export function joinEvent(input: JoinInput): ProtonEvent {
  const raw = dispatch('guildMemberAdd');
  const joinedAt = new Date(input.joinedAt).toISOString();
  const userId = input.userId ?? accountId(input.joinedAt - YEAR_MS);

  const user = raw.d.user as Record<string, unknown>;
  user.id = userId;
  user.avatar = input.avatar ?? null;
  user.bot = input.bot ?? false;
  raw.d.joined_at = joinedAt;

  return {
    id: `member.joined:${GUILD}:${userId}:${joinedAt}`,
    type: 'member.joined',
    guildId: GUILD,
    occurredAt: input.joinedAt,
    payload: raw.d,
  };
}

export interface RunOverrides {
  config: Partial<AntiraidConfig>;
  /** What the bot's role grants. Lower it to exercise the I8 refusal path. */
  botPermissions: bigint;
  /** Role ids per member, as a member fetch would report them. */
  memberRoles: Record<string, string[]>;
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;
  /** Every REST call, in order. */
  calls(): RestRequestOptions[];
  /** Calls that changed a member — role adds and kicks, not alert messages. */
  memberCalls(): RestRequestOptions[];
  /** The raid alert's text, or null if none was posted. */
  alertContent(): string | null;
  cases(): CaseInput[];
  join(input: JoinInput, overrides?: Partial<RunOverrides>): Promise<void>;
}

/**
 * The antiraid listener wired to the real executor.
 *
 * Only Discord itself is faked. The prechecks, the guild-state resolution, the
 * hierarchy arithmetic, the dedupe claim and the sliding-window semantics are all
 * production code paths — the point being that a permissive fake in any of those
 * places is exactly how a module passes its tests and does nothing in a raid.
 */
export function harness(options: { rateWindow?: RateWindowStore } = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const logs: Array<{ level: string; message: string }> = [];
  // Shared across joins, so a burst accumulates and a redelivery meets the claim
  // its first delivery made (I4).
  const dedupe = new MemoryDedupe();
  // The real Redis window is passed in by `join-rate.integration.test.ts`.
  const rateWindow = options.rateWindow ?? new MemoryRateWindow();

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const isMessage = (call: RestRequestOptions) => call.path.endsWith('/messages');

  return {
    rest,
    recorder,
    logs,
    calls: () => rest.calls,
    memberCalls: () => rest.calls.filter((call) => !isMessage(call)),
    alertContent: () => {
      const call = rest.calls.find(isMessage);
      return (call?.body as { content?: string } | undefined)?.content ?? null;
    },
    cases: () => recorder.recorded,

    async join(input, overrides = {}) {
      const botPermissions = overrides.botPermissions ?? BOT_PERMISSIONS;
      const memberRoles = overrides.memberRoles ?? {};

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
        resolveContext: async (request, hints) => {
          const resolved = await resolvePrecheckContext(
            {
              store,
              botUserId: BOT,
              // A member who just joined holds no roles; the fetch answering with
              // an empty list is what production's single-member lookup returns.
              fetchMemberRoles: async (_guildId, userId) => memberRoles[userId] ?? [],
            },
            request,
            (hints ?? {}) as ResolveContextHints,
          );
          return 'context' in resolved ? resolved.context : resolved;
        },
      });

      const listener = createAntiraidModule({ rateWindow }).listeners?.[0];
      if (!listener) throw new Error('antiraid declares no listener');

      const ctx: ModuleContext<AntiraidConfig> = {
        guildId: GUILD,
        config: { ...antiraidDefaultConfig, ...overrides.config },
        executor,
        logger,
      };

      await listener.handler(joinEvent(input), ctx);
    },
  };
}
