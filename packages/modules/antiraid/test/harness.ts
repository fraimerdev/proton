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

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const ALERT_CHANNEL = '500000000000000001';
export const VERIFY_ROLE = '410000000000000002';
export const QUARANTINE_ROLE = '410000000000000003';

const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000005';

export const HIGH_ROLE = '410000000000000009';

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

export function accountId(createdAt: number): string {
  return String((BigInt(Math.trunc(createdAt)) - BigInt(DISCORD_EPOCH_MS)) << 22n);
}

export interface JoinInput {
  userId?: string;

  joinedAt: number;

  avatar?: string | null;
  bot?: boolean;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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

  botPermissions: bigint;

  memberRoles: Record<string, string[]>;
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];

  memberCalls(): RestRequestOptions[];

  alertContent(): string | null;
  cases(): CaseInput[];
  join(input: JoinInput, overrides?: Partial<RunOverrides>): Promise<void>;
}

export function harness(options: { rateWindow?: RateWindowStore } = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const logs: Array<{ level: string; message: string }> = [];

  const dedupe = new MemoryDedupe();

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
