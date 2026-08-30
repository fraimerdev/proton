import {
  type CaseInput,
  type CaseRecorder,
  type DedupeStore,
  DefaultActionExecutor,
  type GuildRole,
  type GuildState,
  type GuildStateStore,
  type Logger,
  type ModuleContext,
  newId,
  Permissions,
  type PrecheckInput,
  type ProtonEvent,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { type BrandingConfig, brandingDefaultConfig } from '../src/config.ts';
import type { BrandingDeps } from '../src/deps.ts';
import type { AssetKind } from '../src/kinds.ts';
import { createBrandingListener } from '../src/listeners.ts';
import type { BrandingAsset, BrandingAssetStore, BrandingRoleStore } from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const ADMIN = '100000000000000001';

export const EVERYONE_ROLE = GUILD;
export const BOT_ROLE = '410000000000000005';

export const BOT_PERMISSIONS =
  Permissions.ViewChannel | Permissions.ChangeNickname | Permissions.ManageRoles;

export const WITHOUT_NICKNAME = Permissions.ViewChannel;

export const AVATAR_HASH = 'av1';
export const BANNER_HASH = 'bn1';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

export const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

export function guildState(botPermissions: bigint): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(),
    memberCount: 10,
    updatedAt: Date.now(),
  };
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

    // Discord answers a role creation with the role, and the id in it is the only way Proton can
    // ever find that role again.
    if (options.method === 'POST' && options.path.endsWith('/roles')) {
      return { status: 201, body: { id: COLOUR_ROLE } };
    }

    return this.response;
  }
}

export class MemoryAssetStore implements BrandingAssetStore {
  readonly requested: AssetKind[] = [];
  readonly missing = new Set<AssetKind>();

  async get(_guildId: string, kind: AssetKind): Promise<BrandingAsset | null> {
    this.requested.push(kind);
    if (this.missing.has(kind)) return null;

    return {
      kind,
      contentType: 'image/png',
      base64: PNG_BASE64,
      hash: kind === 'avatar' ? AVATAR_HASH : BANNER_HASH,
      byteSize: PNG_BYTES.byteLength,
    };
  }

  async put(): Promise<void> {
    return undefined;
  }

  async remove(): Promise<void> {
    return undefined;
  }
}

export const COLOUR_ROLE = '410000000000000077';

export class MemoryRoleStore implements BrandingRoleStore {
  held: string | null = null;
  readonly written: string[] = [];

  async get(): Promise<string | null> {
    return this.held;
  }

  async put(_guildId: string, roleId: string): Promise<void> {
    this.held = roleId;
    this.written.push(roleId);
  }

  async forget(): Promise<void> {
    this.held = null;
  }
}

export function configChanged(
  overrides: Partial<{ auditId: string; enabledBefore: boolean; enabledAfter: boolean }> = {},
): ProtonEvent {
  return {
    id: `proton.config_changed:${overrides.auditId ?? 'audit-1'}`,
    type: 'proton.config_changed',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      auditId: overrides.auditId ?? 'audit-1',
      guildId: GUILD,
      moduleId: 'branding',
      actorId: ADMIN,
      source: 'dashboard',
      enabledBefore: overrides.enabledBefore ?? true,
      enabledAfter: overrides.enabledAfter ?? true,
      changedKeys: ['nickname'],
    },
  };
}

export interface MemberFacts {
  nick?: string | null;
  avatar?: string | null;
  banner?: string | null;
}

export function guildAvailable(member: MemberFacts | null): ProtonEvent {
  return {
    id: `guild.available:${GUILD}`,
    type: 'guild.available',
    guildId: GUILD,
    occurredAt: Date.now(),
    payload: {
      id: GUILD,
      name: 'Test guild',
      members:
        member === null
          ? []
          : [
              { user: { id: BOT }, ...member },
              { user: { id: ADMIN }, nick: 'Someone else' },
            ],
    },
  };
}

export interface Harness {
  rest: FakeRest;
  assets: MemoryAssetStore;
  roles: MemoryRoleStore;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  patches(): RestRequestOptions[];
  bodies(): Record<string, unknown>[];

  listen(event: ProtonEvent, config?: Partial<BrandingConfig>): Promise<void>;
}

export interface HarnessOptions {
  botPermissions?: bigint;
  deps?: Partial<BrandingDeps>;
  status?: number;
}

export function harness(options: HarnessOptions = {}): Harness {
  const state = guildState(options.botPermissions ?? BOT_PERMISSIONS);

  const rest = new FakeRest();
  if (options.status !== undefined) rest.response = { status: options.status, body: {} };

  const assets = new MemoryAssetStore();
  const roles = new MemoryRoleStore();
  const recorder = new MemoryRecorder();
  const dedupe = new MemoryDedupe();
  const logs: Array<{ level: string; message: string }> = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const store: GuildStateStore = {
    get: async () => state,
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

  const deps: BrandingDeps = {
    assets,
    roles,
    botUserId: BOT,
    applicationId: BOT,
    ...options.deps,
  };

  const listener = createBrandingListener(deps);

  return {
    rest,
    assets,
    roles,
    recorder,
    logs,

    calls: () => rest.calls,
    patches: () => rest.calls.filter((call) => call.method === 'PATCH'),
    bodies: () =>
      rest.calls
        .filter((call) => call.method === 'PATCH')
        .map((call) => (call.body ?? {}) as Record<string, unknown>),

    async listen(event: ProtonEvent, config: Partial<BrandingConfig> = {}): Promise<void> {
      const ctx: ModuleContext<BrandingConfig> = {
        guildId: GUILD,
        config: { ...brandingDefaultConfig, enabled: true, ...config },
        executor,
        logger,
      };

      await listener.handler(event, ctx);
    },
  };
}
