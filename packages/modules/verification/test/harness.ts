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
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import type { VerificationConfig } from '../src/config.ts';
import { verificationDefaultConfig } from '../src/config.ts';
import type { VerificationDeps } from '../src/deps.ts';
import { handleJoin, type JoinGateOutcome } from '../src/gate.ts';
import { createVerificationModule } from '../src/index.ts';
import type { QuarantineRecord, QuarantineStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MODERATOR = '100000000000000001';
export const CHANNEL = '500000000000000001';

/** Holds two ordinary roles. The common case for quarantine. */
export const MEMBER = '400000000000000001';
/** Holds nothing but @everyone — the "no roles" case. */
export const BARE = '400000000000000002';
/** A fresh joiner. */
export const JOINER = '400000000000000003';

export const EVERYONE_ROLE = GUILD;
export const UNVERIFIED_ROLE = '410000000000000001';
export const QUARANTINE_ROLE = '410000000000000002';
export const LOW_ROLE = '410000000000000003';
export const MID_ROLE = '410000000000000004';
export const VERIFIED_ROLE = '410000000000000005';
export const BOT_ROLE = '410000000000000006';
/** Positioned above the bot: every grant of it must be refused (I8 hierarchy). */
export const ABOVE_BOT_ROLE = '410000000000000009';

/** Role positions. The bot sits at 6; ABOVE_BOT_ROLE at 9. */
const POSITIONS: Record<string, number> = {
  [EVERYONE_ROLE]: 0,
  [UNVERIFIED_ROLE]: 1,
  [QUARANTINE_ROLE]: 2,
  [LOW_ROLE]: 3,
  [MID_ROLE]: 4,
  [VERIFIED_ROLE]: 5,
  [BOT_ROLE]: 6,
  [ABOVE_BOT_ROLE]: 9,
};

export const BOT_PERMISSIONS = Permissions.ViewChannel | Permissions.ManageRoles;

function roles(): Map<string, GuildRole> {
  return new Map(
    Object.entries(POSITIONS).map(([id, position]) => [
      id,
      {
        id,
        permissions: id === BOT_ROLE ? BOT_PERMISSIONS : 0n,
        position,
      },
    ]),
  );
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

export class MemoryQuarantineStore implements QuarantineStore {
  readonly records = new Map<string, QuarantineRecord>();

  async get(guildId: string, userId: string): Promise<QuarantineRecord | null> {
    return this.records.get(`${guildId}:${userId}`) ?? null;
  }

  async put(record: QuarantineRecord): Promise<void> {
    this.records.set(`${record.guildId}:${record.userId}`, record);
  }

  async clear(guildId: string, userId: string): Promise<void> {
    this.records.delete(`${guildId}:${userId}`);
  }
}

/**
 * A REST proxy that also *applies* the role changes it is told to make.
 *
 * The whole claim this module makes is "restoration is exact", and a fake that
 * merely records calls cannot check that: it would let a test assert the right
 * requests were sent while the member ended up holding the wrong set. So the
 * member's roles are a real mutable set here, and the restore assertions compare
 * it against what they held before.
 */
class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  readonly memberRoles: Map<string, Set<string>>;
  /** Paths to answer with this status instead of 204. */
  readonly failures = new Map<string, RestResponse>();

  constructor(memberRoles: Map<string, Set<string>>) {
    this.memberRoles = memberRoles;
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const failure = this.failures.get(options.path);
    if (failure) return failure;

    const match = /^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/.exec(options.path);
    if (match) {
      const userId = match[1] as string;
      const roleId = match[2] as string;
      const held = this.memberRoles.get(userId);
      if (held) {
        if (options.method === 'PUT') held.add(roleId);
        if (options.method === 'DELETE') held.delete(roleId);
      }
    }

    return { status: 204, body: {} };
  }
}

export interface RunOverrides {
  config: Partial<VerificationConfig>;
  /** Overrides Discord's `app_permissions` for the interaction channel. */
  appPermissions: bigint;
  /** Reused between two runs to exercise redelivery (I4). */
  idempotencyKey: string;
  /** Who ran the command. Defaults to the moderator. */
  userId: string;
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  quarantine: MemoryQuarantineStore;
  logs: Array<{ level: string; message: string }>;
  /** Mutable role positions, so a test can move Proton's role down mid-quarantine. */
  positions: Map<string, number>;
  /** Mutable membership, shared with the fake REST proxy. */
  memberRoles: Map<string, Set<string>>;
  deps: VerificationDeps;
  /** Role ids the member holds now, as the fake Discord sees them. */
  rolesOf(userId: string): string[];
  /** REST calls that are not the interaction acknowledgement. */
  discordCalls(): RestRequestOptions[];
  /** Recorded cases, minus the ones every reply writes. */
  cases(): CaseInput[];
  /** Every reply sent, in order. */
  replies(): string[];
  /** The last thing the invoker was told, or null. */
  replyContent(): string | null;
  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  join(
    payload: Record<string, unknown>,
    config?: Partial<VerificationConfig>,
  ): Promise<JoinGateOutcome>;
}

/**
 * A verification command wired to the real executor.
 *
 * Only the REST proxy and the two module-declared ports are faked. The
 * prechecks, the guild-state resolution, the hierarchy arithmetic and the dedupe
 * claim are all production code paths — which is the point: the Gate 0 stub
 * passed its tests precisely because those were replaced with permissive fakes.
 */
export function harness(options: { deleteRole?: string } = {}): Harness {
  const positions = new Map(Object.entries(POSITIONS));
  if (options.deleteRole) positions.delete(options.deleteRole);

  const memberRoles = new Map<string, Set<string>>([
    [MEMBER, new Set([EVERYONE_ROLE, LOW_ROLE, MID_ROLE])],
    [BARE, new Set([EVERYONE_ROLE])],
    [JOINER, new Set([EVERYONE_ROLE])],
    [MODERATOR, new Set([EVERYONE_ROLE, MID_ROLE])],
  ]);

  const rest = new FakeRest(memberRoles);
  const recorder = new MemoryRecorder();
  const quarantine = new MemoryQuarantineStore();
  const logs: Array<{ level: string; message: string }> = [];
  const dedupe = new MemoryDedupe();

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const guildState = (): GuildState => {
    const map = roles();
    // Re-read positions each call so a test can move a role between actions.
    for (const [id, role] of map) {
      const position = positions.get(id);
      if (position === undefined) map.delete(id);
      else map.set(id, { ...role, position });
    }
    return {
      guildId: GUILD,
      ownerId: OWNER,
      everyoneRoleId: EVERYONE_ROLE,
      roles: map,
      botRoleIds: [BOT_ROLE],
      channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
      updatedAt: Date.now(),
    };
  };

  const store: GuildStateStore = {
    get: async () => guildState(),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const fetchMemberRoles = async (_guildId: string, userId: string): Promise<string[] | null> => {
    const held = memberRoles.get(userId);
    return held ? [...held] : null;
  };

  const deps: VerificationDeps = {
    guildState: store,
    fetchMemberRoles,
    quarantine,
    now: () => 1_700_000_000_000,
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
        { store, botUserId: BOT, fetchMemberRoles },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  const discordCalls = () => rest.calls.filter((call) => !call.path.startsWith('/interactions/'));

  const replies = (): string[] =>
    rest.calls
      .filter((call) => call.path.startsWith('/interactions/'))
      .map(
        (call) => (call.body as { data?: { content?: string } } | undefined)?.data?.content ?? '',
      );

  return {
    rest,
    recorder,
    quarantine,
    logs,
    positions,
    memberRoles,
    deps,
    discordCalls,
    replies,
    rolesOf: (userId) => [...(memberRoles.get(userId) ?? [])],
    replyContent: () => replies().at(-1) ?? null,
    cases: () => recorder.recorded.filter((c) => c.kind !== 'interaction_reply'),

    async run(command, commandOptions, overrides = {}) {
      const module = createVerificationModule(deps);
      const definition = module.commands?.find((c) => c.name === command);
      if (!definition) throw new Error(`no such verification command: ${command}`);

      const ctx: CommandContext<VerificationConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: overrides.userId ?? MODERATOR,
        config: { ...verificationDefaultConfig, ...overrides.config },
        executor: executor.scoped({
          channelId: CHANNEL,
          appPermissions: overrides.appPermissions ?? BOT_PERMISSIONS,
        }),
        logger,
        options: createCommandOptions(commandOptions),
        interaction: { id: '600000000000000001', token: 'interaction-token' },
        idempotencyKey: overrides.idempotencyKey ?? newId(),
      };

      await definition.handler(ctx);
    },

    async join(payload, config = {}) {
      const event: ProtonEvent = {
        id: `event-${newId()}`,
        type: 'member.joined',
        guildId: GUILD,
        occurredAt: Date.now(),
        payload,
      };

      const ctx: ModuleContext<VerificationConfig> = {
        guildId: GUILD,
        config: { ...verificationDefaultConfig, ...config },
        executor: executor.scoped({ appPermissions: BOT_PERMISSIONS }),
        logger,
      };

      return handleJoin(event, ctx, deps);
    },
  };
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

/** A GUILD_MEMBER_ADD payload, as the normaliser passes it through. */
export function joinPayload(userId: string, roleIds: string[] = []): Record<string, unknown> {
  return {
    guild_id: GUILD,
    joined_at: '2026-08-15T12:00:00.000000+00:00',
    roles: roleIds,
    user: { id: userId, username: 'joiner', avatar: null, bot: false },
  };
}

/** The gate config a working guild would have. */
export const GATED: Partial<VerificationConfig> = {
  enabled: true,
  unverifiedRoleId: UNVERIFIED_ROLE,
  verifiedRoleId: VERIFIED_ROLE,
};

/** The quarantine config a working guild would have. */
export const QUARANTINED: Partial<VerificationConfig> = {
  enabled: true,
  quarantineRoleId: QUARANTINE_ROLE,
};
