import {
  type CommandContext,
  type CommandWorkerView,
  type ContextMenuContext,
  commandSettingsViewSchema,
  type Logger,
  type ModuleManifest,
  ModuleRegistry,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
} from '@proton/core';
import type {
  CommandPermissionsCheck,
  CommandRegistrationCheck,
  CommandRegistrationFailed,
  CommandRegistrationRecord,
  CommandRegistrationSuccess,
} from '@proton/db';
import { z } from 'zod';
import type {
  RegistrationHeld,
  RegistrationStore,
  StaleGuildsOptions,
} from '../src/command-sync.ts';

export const APPLICATION = '800000000000000001';
export const TEST_GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const THIRD_GUILD = '900000000000000003';

export const USER = 6;
export const STRING = 3;

export interface Seen {
  commands: Array<{ key: string; ctx: CommandContext }>;
  menus: Array<{ key: string; ctx: ContextMenuContext }>;
}

export function emptySeen(): Seen {
  return { commands: [], menus: [] };
}

const configSchema = z.object({ enabled: z.boolean().default(true) });

function base(id: string, name: string): Omit<ModuleManifest, 'commands'> {
  return {
    id,
    name,
    category: 'utility',
    configSchema,
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    actionKinds: ['interaction_reply'],
  } as unknown as Omit<ModuleManifest, 'commands'>;
}

const userAndReason = (userDescription: string) => [
  { name: 'user', description: userDescription, type: USER, required: true },
  { name: 'reason', description: 'Why.', type: STRING },
];

export function commandRegistry(
  seen: Seen = emptySeen(),
  reply?: { default: 'private' | 'public'; toggleable: string[] },
): ModuleRegistry {
  const chat = (
    name: string,
    data: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    name,
    description: String(data.description),
    data: { name, ...data },
    handler: async (ctx: CommandContext) => {
      seen.commands.push({ key: name, ctx });
    },
    ...extra,
  });

  const registry = new ModuleRegistry();

  registry.register({
    ...base('ping', 'Ping'),
    dashboard: { icon: 'activity', sections: [] },
    commands: [chat('ping', { description: 'Check that Proton answers.' })],
  } as unknown as ModuleManifest);

  registry.register({
    ...base('help', 'Help'),
    commands: [chat('help', { description: 'Find the dashboard.' }, { alwaysRegistered: true })],
  } as unknown as ModuleManifest);

  registry.register({
    ...base('moderation', 'Moderation'),
    dashboard: { icon: 'shield', sections: [] },
    commands: [
      chat(
        'ban',
        {
          description: 'Ban a member.',
          options: [
            { name: 'add', description: 'Ban a member.', type: 1, options: userAndReason('Who.') },
            {
              name: 'remove',
              description: 'Lift a ban.',
              type: 1,
              options: [
                { name: 'user_id', description: 'Their id.', type: STRING, required: true },
              ],
            },
          ],
        },
        reply ? { reply } : {},
      ),
      chat('kick', { description: 'Kick a member.', options: userAndReason('Who.') }),
      chat('warn', {
        description: 'Warn a member.',
        options: [
          { name: 'add', description: 'Warn.', type: 1, options: userAndReason('Who.') },
          { name: 'remove', description: 'Unwarn.', type: 1, options: userAndReason('Who.') },
        ],
      }),
      chat('timeout', {
        description: 'Time a member out.',
        options: [
          { name: 'add', description: 'Time out.', type: 1, options: userAndReason('Who.') },
          { name: 'remove', description: 'Lift.', type: 1, options: userAndReason('Who.') },
        ],
      }),
    ],
    contextMenus: [
      {
        name: 'Report user',
        type: 'user',
        description: 'Report a member.',
        data: { name: 'Report user', type: 2 },
        handler: async (ctx: ContextMenuContext) => {
          seen.menus.push({ key: 'user:Report user', ctx });
        },
      },
      {
        name: 'Punish author',
        type: 'message',
        description: 'Punish the author.',
        data: { name: 'Punish author', type: 3 },
        handler: async (ctx: ContextMenuContext) => {
          seen.menus.push({ key: 'message:Punish author', ctx });
        },
      },
    ],
  } as unknown as ModuleManifest);

  return registry;
}

export function settingsOf(
  input: Partial<z.input<typeof commandSettingsViewSchema>> = {},
): z.infer<typeof commandSettingsViewSchema> {
  return commandSettingsViewSchema.parse(input);
}

export function viewOf(
  modulesOn: Record<string, boolean>,
  settings: Record<string, Partial<z.input<typeof commandSettingsViewSchema>>> = {},
): CommandWorkerView {
  return {
    modulesOn,
    settings: Object.fromEntries(
      Object.entries(settings).map(([key, value]) => [key, settingsOf(value)]),
    ),
  };
}

export class MemoryViews {
  readonly views = new Map<string, CommandWorkerView>();
  reads = 0;
  failWith: Error | null = null;

  async get(guildId: string): Promise<CommandWorkerView> {
    this.reads += 1;
    if (this.failWith) throw this.failWith;
    return structuredClone(this.views.get(guildId) ?? viewOf({}));
  }
}

export class MemoryRegistrations implements RegistrationStore {
  readonly records = new Map<string, CommandRegistrationRecord>();
  readonly left = new Set<string>();
  readonly calls: string[] = [];
  readonly staleCalls: Array<{ limit: number; options: StaleGuildsOptions }> = [];
  stale: string[] = [];
  unchecked: string[] = [];
  clock = () => new Date('2026-09-22T12:00:00.000Z').toISOString();

  async get(guildId: string): Promise<CommandRegistrationRecord | null> {
    this.calls.push(`get:${guildId}`);
    const record = this.records.get(guildId);
    return record ? structuredClone(record) : null;
  }

  async now(): Promise<string> {
    this.calls.push('now');
    return this.clock();
  }

  #blank(guildId: string, scope: CommandRegistrationRecord['scope']): CommandRegistrationRecord {
    return {
      guildId,
      scope,
      definitionHash: null,
      commands: [],
      idHistory: {},
      checkedAt: null,
      syncedAt: null,
      failure: null,
      permissionsCheckedAt: null,
      lostPermissions: null,
    };
  }

  async recordSuccess(guildId: string, input: CommandRegistrationSuccess): Promise<boolean> {
    this.calls.push(`recordSuccess:${guildId}`);
    if (this.left.has(guildId)) return false;

    const current = this.records.get(guildId) ?? this.#blank(guildId, input.scope);
    const at = this.clock();
    this.records.set(guildId, {
      ...current,
      scope: input.scope,
      definitionHash: input.hash,
      commands: input.commands,
      idHistory: {
        ...current.idHistory,
        ...Object.fromEntries(input.commands.map((command) => [command.id, command.key])),
      },
      checkedAt: input.checkedAt ?? at,
      syncedAt: at,
      failure: null,
    });
    return true;
  }

  async recordChecked(guildId: string, input: CommandRegistrationCheck): Promise<boolean> {
    this.calls.push(`recordChecked:${guildId}`);
    const current = this.records.get(guildId);
    if (!current || this.left.has(guildId) || current.definitionHash !== input.hash) return false;
    this.records.set(guildId, {
      ...current,
      scope: input.scope,
      checkedAt: input.checkedAt ?? this.clock(),
    });
    return true;
  }

  async recordFailure(guildId: string, input: CommandRegistrationFailed): Promise<boolean> {
    this.calls.push(`recordFailure:${guildId}`);
    if (this.left.has(guildId)) return false;
    const current = this.records.get(guildId) ?? this.#blank(guildId, input.scope);
    this.records.set(guildId, {
      ...current,
      scope: input.scope,
      definitionHash: null,
      failure: { ...input.failure, hash: input.failure.hash ?? null },
      checkedAt: input.checkedAt ?? this.clock(),
    });
    return true;
  }

  async recordHeld(guildId: string, input: RegistrationHeld): Promise<boolean> {
    this.calls.push(`recordHeld:${guildId}`);
    const current = this.records.get(guildId);
    if (!current?.failure || this.left.has(guildId)) return false;
    this.records.set(guildId, {
      ...current,
      scope: input.scope,
      failure: { ...current.failure, hash: input.hash },
      checkedAt: input.checkedAt ?? this.clock(),
    });
    return true;
  }

  async recordPermissions(guildId: string, input: CommandPermissionsCheck): Promise<boolean> {
    this.calls.push(`recordPermissions:${guildId}`);
    if (this.left.has(guildId)) return false;
    const current = this.records.get(guildId) ?? this.#blank(guildId, input.scope);
    this.records.set(guildId, {
      ...current,
      permissionsCheckedAt: input.at,
      lostPermissions:
        input.lost.length > 0 ? { commands: input.lost, at: input.at } : current.lostPermissions,
    });
    return true;
  }

  async forget(guildId: string): Promise<boolean> {
    this.calls.push(`forget:${guildId}`);
    return this.records.delete(guildId);
  }

  async staleGuilds(limit: number, options: StaleGuildsOptions = {}): Promise<string[]> {
    this.calls.push(`staleGuilds:${limit}`);
    this.staleCalls.push({ limit, options });

    const unchecked = options.includeUnchecked
      ? this.unchecked.filter((guildId) => {
          const record = this.records.get(guildId);
          return !record || (record.permissionsCheckedAt === null && record.failure === null);
        })
      : [];
    return [...new Set([...this.stale, ...unchecked])]
      .filter((guildId) => options.onlyGuildId === undefined || guildId === options.onlyGuildId)
      .slice(0, limit);
  }
}

interface DiscordCommand {
  id: string;
  name: string;
  type: number;
}

export class FakeDiscord implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  readonly guildCommands = new Map<string, DiscordCommand[]>();
  globals: DiscordCommand[] = [];
  readonly permissions = new Map<string, unknown[]>();
  guilds: Array<{ id: string; name: string }> = [];
  readonly failures: Array<(options: RestRequestOptions) => RestResponse | Error | undefined> = [];
  #next = 1_300_000_000_000_000_000n;

  failNext(respond: (options: RestRequestOptions) => RestResponse | Error | undefined): void {
    this.failures.push(respond);
  }

  puts(guildId?: string): RestRequestOptions[] {
    return this.calls.filter(
      (call) =>
        call.method === 'PUT' &&
        (guildId === undefined || call.path.includes(`/guilds/${guildId}/commands`)),
    );
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(structuredClone(options));

    const failure = this.failures[0]?.(options);
    if (failure !== undefined) {
      this.failures.shift();
      if (failure instanceof Error) throw failure;
      return failure;
    }

    const guildPath = options.path.match(
      /^\/applications\/\d+\/guilds\/(\d+)\/commands(\/permissions)?$/,
    );
    const globalPath = options.path === `/applications/${APPLICATION}/commands`;

    if (options.method === 'GET' && options.path.startsWith('/users/@me/guilds')) {
      return { status: 200, body: structuredClone(this.guilds) };
    }
    if (options.method === 'GET' && guildPath?.[2]) {
      return { status: 200, body: structuredClone(this.permissions.get(guildPath[1] ?? '') ?? []) };
    }
    if (options.method === 'GET' && globalPath) {
      return { status: 200, body: structuredClone(this.globals) };
    }
    if (options.method === 'PUT' && (guildPath || globalPath)) {
      const current = globalPath
        ? this.globals
        : (this.guildCommands.get(guildPath?.[1] ?? '') ?? []);
      const next = (options.body as Array<{ id?: string; name: string; type?: number }>).map(
        (body) => {
          const type = body.type ?? 1;
          const kept =
            body.id ??
            current.find((command) => command.type === type && command.name === body.name)?.id;
          this.#next += 1n;
          return { id: kept ?? String(this.#next), name: body.name, type };
        },
      );
      if (globalPath) this.globals = next;
      else this.guildCommands.set(guildPath?.[1] ?? '', next);
      return { status: 200, body: structuredClone(next) };
    }

    return { status: 404, body: { message: 'Unknown route', code: 0 } };
  }
}

export function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(`info: ${message}`),
      warn: (message) => lines.push(`warn: ${message}`),
      error: (message) => lines.push(`error: ${message}`),
    },
  };
}
