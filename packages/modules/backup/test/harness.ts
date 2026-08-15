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
import { dispatch } from '@proton/fixtures';
import { createBackupCommands } from '../src/commands.ts';
import { type BackupConfig, backupDefaultConfig } from '../src/config.ts';
import type { BackupDeps } from '../src/deps.ts';
import type { ChannelSnapshot, GuildLayout, LayoutSource, RoleSnapshot } from '../src/snapshot.ts';
import type { BackupRecord, BackupStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const ADMIN = '100000000000000001';
export const COMMAND_CHANNEL = '500000000000000001';

export const HIDDEN_CHANNEL = '500000000000000002';

export const EVERYONE_ROLE = GUILD;
const BOT_ROLE = '410000000000000008';

export const NOW = Date.parse('2026-08-15T12:00:00.000Z');

export const BOT_PERMISSIONS =
  Permissions.ViewChannel | Permissions.SendMessages | Permissions.ManageChannels;

export function fixtureLayout(name: 'guildCreate' | 'channelObfuscated'): GuildLayout {
  const payload = dispatch(name).d;

  return {
    guildId: String(payload.id),
    source: 'gateway',
    channels: Array.isArray(payload.channels) ? payload.channels : [],
    roles: Array.isArray(payload.roles) ? payload.roles : [],
  };
}

export function layout(
  channels: readonly unknown[],
  roles: readonly unknown[] = [],
  source: LayoutSource = 'gateway',
): GuildLayout {
  return { guildId: GUILD, source, channels, roles };
}

export function rawChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '500000000000000010',
    type: 0,
    name: 'general',
    position: 0,
    parent_id: null,
    flags: 0,
    permission_overwrites: [],
    ...overrides,
  };
}

export function rawRole(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '400000000000000010',
    name: 'Member',
    permissions: '3072',
    position: 1,
    color: 0,
    hoist: false,
    mentionable: false,
    managed: false,
    ...overrides,
  };
}

export function toRawChannel(channel: ChannelSnapshot): Record<string, unknown> {
  return {
    id: channel.id,
    type: channel.type,
    position: channel.position,
    parent_id: channel.parentId,
    flags: 0,
    name: channel.name,
    topic: channel.topic,
    nsfw: channel.nsfw,
    rate_limit_per_user: channel.rateLimitPerUser,
    bitrate: channel.bitrate,
    user_limit: channel.userLimit,
    permission_overwrites: channel.overwrites.map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow,
      deny: overwrite.deny,
    })),
  };
}

export function toRawRole(role: RoleSnapshot): Record<string, unknown> {
  return {
    id: role.id,
    name: role.name,
    permissions: role.permissions,
    position: role.position,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    managed: role.managed,
  };
}

export class MemoryBackupStore implements BackupStore {
  readonly records: BackupRecord[] = [];

  failNextSave: string | null = null;

  async save(record: BackupRecord): Promise<void> {
    if (this.failNextSave) {
      const message = this.failNextSave;
      this.failNextSave = null;
      throw new Error(message);
    }
    this.records.push(record);
  }

  async get(guildId: string, backupId: string): Promise<BackupRecord | null> {
    return this.records.find((r) => r.guildId === guildId && r.id === backupId) ?? null;
  }

  async list(guildId: string, limit: number): Promise<BackupRecord[]> {
    return this.records
      .filter((r) => r.guildId === guildId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async prune(guildId: string, keep: number): Promise<number> {
    const mine = this.records
      .filter((r) => r.guildId === guildId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const doomed = new Set(mine.slice(keep).map((r) => r.id));
    if (doomed.size === 0) return 0;

    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record && doomed.has(record.id)) this.records.splice(i, 1);
    }

    return doomed.size;
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

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return { status: 200, body: {} };
  }
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface HarnessOptions {
  store?: BackupStore;

  layout?: GuildLayout | null;

  omit?: Array<keyof BackupDeps>;
  botPermissions?: bigint;
  backupId?: string;
}

export interface Harness {
  store: BackupStore;
  logs: LogLine[];
  deps: BackupDeps;

  current: { layout: GuildLayout | null };
  run(options: RawOption[], config?: Partial<BackupConfig>): Promise<void>;
  replyContent(): string | null;
  logged(level: LogLine['level'], fragment: string): boolean;
}

export function harness(options: HarnessOptions = {}): Harness {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: LogLine[] = [];
  const store = options.store ?? new MemoryBackupStore();
  const omit = new Set<keyof BackupDeps>(options.omit ?? []);
  const current = {
    layout: options.layout === undefined ? fixtureLayout('guildCreate') : options.layout,
  };

  const roles = new Map<string, GuildRole>([
    [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
    [
      BOT_ROLE,
      { id: BOT_ROLE, permissions: options.botPermissions ?? BOT_PERMISSIONS, position: 8 },
    ],
  ]);

  const state: GuildState = {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles,
    botRoleIds: [BOT_ROLE],
    channels: new Map([[COMMAND_CHANNEL, { id: COMMAND_CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: NOW,
  };

  const guildState: GuildStateStore = {
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

  const deps: BackupDeps = {
    now: () => NOW,
    newBackupId: () => options.backupId ?? '01JBACKUP00000000000000001',
  };
  if (!omit.has('store')) deps.store = store;
  if (!omit.has('readLayout')) deps.readLayout = async () => current.layout;

  const executor = new DefaultActionExecutor({
    dedupe,
    rest,
    recorder,
    resolveContext: async (
      request,
      hints,
    ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
      const resolved = await resolvePrecheckContext(
        { store: guildState, botUserId: BOT },
        request,
        (hints ?? {}) as ResolveContextHints,
      );
      return 'context' in resolved ? resolved.context : resolved;
    },
  });

  return {
    store,
    logs,
    deps,
    current,

    async run(raw, config = {}) {
      const command = createBackupCommands(deps)[0];
      if (!command) throw new Error('the backup module declares no commands');

      const ctx: CommandContext<BackupConfig> = {
        guildId: GUILD,
        channelId: COMMAND_CHANNEL,
        userId: ADMIN,
        config: { ...backupDefaultConfig, ...config },
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

    replyContent() {
      const call = rest.calls.filter((c) => c.path.startsWith('/interactions/')).at(-1);
      const body = call?.body as { data?: { content?: string } } | undefined;
      return body?.data?.content ?? null;
    },

    logged: (level, fragment) =>
      logs.some((line) => line.level === level && line.message.includes(fragment)),
  };
}

export function subcommand(name: string, options: RawOption[] = []): RawOption[] {
  return [{ name, type: OptionType.Subcommand, options }];
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}
