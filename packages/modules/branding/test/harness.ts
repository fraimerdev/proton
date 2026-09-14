import {
  type ActionExecutor,
  type ActionKind,
  type BotNameStyle,
  type BrandingNameStyleStore,
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
  type NameStyleAttempt,
  type NameStyleState,
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
import { createBrandingCommand } from '../src/commands.ts';
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
export const BOT_ROLE_POSITION = 5;

export const BOT_PERMISSIONS =
  Permissions.ViewChannel | Permissions.ChangeNickname | Permissions.ManageRoles;

export const WITHOUT_NICKNAME = Permissions.ViewChannel;

export const AVATAR_HASH = 'av1';
export const BANNER_HASH = 'bn1';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

export const PNG_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

export const MEMBER_PATH = `/guilds/${GUILD}/members/${BOT}`;

export const COLOUR_ROLE = '410000000000000077';

export function guildState(botPermissions: bigint, colourRolePosition = 1): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: EVERYONE_ROLE,
    roles: new Map<string, GuildRole>([
      [EVERYONE_ROLE, { id: EVERYONE_ROLE, permissions: Permissions.ViewChannel, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: botPermissions, position: BOT_ROLE_POSITION }],
      [COLOUR_ROLE, { id: COLOUR_ROLE, permissions: 0n, position: colourRolePosition }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(),
    memberCount: 10,
    updatedAt: Date.now(),
  };
}

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();
  readonly keys: string[] = [];

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    this.keys.push(key);
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

export interface WireStyle {
  font_id: number;
  effect_id: number;
  colors: number[];
}

export function wire(style: BotNameStyle): WireStyle {
  return { font_id: style.fontId, effect_id: style.effectId, colors: [...style.colours] };
}

export function isStyleBody(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && 'display_name_font_id' in body;
}

function echoed(body: Record<string, unknown>): Record<string, unknown> {
  const styles =
    body.display_name_font_id === null
      ? null
      : {
          font_id: body.display_name_font_id,
          effect_id: body.display_name_effect_id,
          colors: body.display_name_colors,
        };

  return { user: { id: BOT, display_name_styles: null }, display_name_styles: styles };
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  response: RestResponse = { status: 200, body: {} };
  styleAnswer: 'echo' | RestResponse | Error = 'echo';
  memberAnswer: RestResponse | Error = { status: 200, body: { user: { id: BOT } } };
  roleDeleteAnswer: RestResponse = { status: 204, body: undefined };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    if (options.method === 'DELETE' && options.path.startsWith(`/guilds/${GUILD}/roles/`)) {
      return this.roleDeleteAnswer;
    }

    if (options.method === 'PATCH' && isStyleBody(options.body)) {
      if (this.styleAnswer instanceof Error) throw this.styleAnswer;
      return this.styleAnswer === 'echo'
        ? { status: 200, body: echoed(options.body) }
        : this.styleAnswer;
    }

    if (options.method === 'GET' && options.path === MEMBER_PATH) {
      if (this.memberAnswer instanceof Error) throw this.memberAnswer;
      return this.memberAnswer;
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

export class MemoryRoleStore implements BrandingRoleStore {
  held: string | null = null;
  forgets = 0;

  async get(): Promise<string | null> {
    return this.held;
  }

  async forget(): Promise<void> {
    this.held = null;
    this.forgets += 1;
  }
}

export class MemoryNameStyleStore implements BrandingNameStyleStore {
  state: NameStyleState | null = null;
  readonly writes: string[] = [];

  async get(): Promise<NameStyleState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async recordAttempt(attempt: NameStyleAttempt): Promise<void> {
    this.writes.push(`attempt:${attempt.outcome}`);

    const confirmed = attempt.outcome === 'confirmed';
    this.state = {
      guildId: attempt.guildId,
      requested: attempt.requested,
      outcome: attempt.outcome,
      reason: attempt.reason,
      attemptedAt: attempt.at,
      confirmed: confirmed ? attempt.requested : (this.state?.confirmed ?? null),
      confirmedAt: confirmed ? attempt.at : (this.state?.confirmedAt ?? null),
      updatedAt: attempt.at,
    };
  }

  async confirmObserved(guildId: string, style: BotNameStyle | null, at: number): Promise<void> {
    this.writes.push('observed');

    this.state = {
      guildId,
      requested: style,
      outcome: 'confirmed',
      reason: null,
      attemptedAt: this.state?.attemptedAt ?? null,
      confirmed: style,
      confirmedAt: at,
      updatedAt: at,
    };
  }

  async forgetConfirmed(_guildId: string, at: number): Promise<void> {
    this.writes.push('forget');
    if (this.state === null) return;

    const wasConfirmed = this.state.outcome === 'confirmed';
    this.state = {
      ...this.state,
      confirmed: null,
      confirmedAt: null,
      updatedAt: at,
      outcome: wasConfirmed ? 'unverified' : this.state.outcome,
      reason: wasConfirmed ? 'changed_in_discord' : this.state.reason,
    };
  }
}

export function configChanged(
  overrides: Partial<{
    auditId: string;
    enabledBefore: boolean;
    enabledAfter: boolean;
    changedKeys: string[];
  }> = {},
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
      changedKeys: overrides.changedKeys ?? ['nickname'],
    },
  };
}

export interface MemberFacts {
  nick?: string | null;
  avatar?: string | null;
  banner?: string | null;
  display_name_styles?: WireStyle | null;
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
  nameStyles: MemoryNameStyleStore;
  recorder: MemoryRecorder;
  logs: Array<{ level: string; message: string }>;

  calls(): RestRequestOptions[];
  patches(): RestRequestOptions[];
  bodies(): Record<string, unknown>[];
  stylePatches(): RestRequestOptions[];
  styleBodies(): Record<string, unknown>[];
  otherCalls(): RestRequestOptions[];
  memberReads(): RestRequestOptions[];
  report(): string | undefined;
  keys(): string[];
  kinds(): ActionKind[];

  listen(event: ProtonEvent, config?: Partial<BrandingConfig>): Promise<void>;
  command(config?: Partial<BrandingConfig>): Promise<void>;
}

export interface HarnessOptions {
  botPermissions?: bigint;
  colourRolePosition?: number;
  deps?: Partial<BrandingDeps>;
  status?: number;
  unbind?: Array<'nameStyles' | 'rest'>;
}

export function harness(options: HarnessOptions = {}): Harness {
  const state = guildState(options.botPermissions ?? BOT_PERMISSIONS, options.colourRolePosition);

  const rest = new FakeRest();
  if (options.status !== undefined) rest.response = { status: options.status, body: {} };

  const assets = new MemoryAssetStore();
  const roles = new MemoryRoleStore();
  const nameStyles = new MemoryNameStyleStore();
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

  const inner = new DefaultActionExecutor({
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

  const requested: ActionKind[] = [];
  const executor: ActionExecutor = {
    execute: (request) => {
      requested.push(request.kind);
      return inner.execute(request);
    },
  };

  const unbind = new Set(options.unbind ?? []);

  const deps: BrandingDeps = {
    assets,
    roles,
    ...(unbind.has('nameStyles') ? {} : { nameStyles }),
    ...(unbind.has('rest') ? {} : { rest }),
    botUserId: BOT,
    applicationId: BOT,
    ...options.deps,
  };

  const listener = createBrandingListener(deps);
  const command = createBrandingCommand(deps);

  const isStyle = (call: RestRequestOptions) => call.method === 'PATCH' && isStyleBody(call.body);
  const isMemberRead = (call: RestRequestOptions) =>
    call.method === 'GET' && call.path === MEMBER_PATH;

  return {
    rest,
    assets,
    roles,
    nameStyles,
    recorder,
    logs,

    calls: () => rest.calls,
    patches: () => rest.calls.filter((call) => call.method === 'PATCH'),
    bodies: () =>
      rest.calls
        .filter((call) => call.method === 'PATCH')
        .map((call) => (call.body ?? {}) as Record<string, unknown>),
    stylePatches: () => rest.calls.filter(isStyle),
    styleBodies: () =>
      rest.calls.filter(isStyle).map((call) => (call.body ?? {}) as Record<string, unknown>),
    otherCalls: () =>
      rest.calls.filter(
        (call) => !isStyle(call) && !isMemberRead(call) && !call.path.startsWith('/webhooks/'),
      ),
    memberReads: () => rest.calls.filter(isMemberRead),
    report: () => {
      const followup = rest.calls.findLast((call) => call.path.startsWith('/webhooks/'));
      const content = (followup?.body as { content?: unknown } | undefined)?.content;
      return typeof content === 'string' ? content : undefined;
    },
    keys: () => dedupe.keys,
    kinds: () => requested,

    async listen(event: ProtonEvent, config: Partial<BrandingConfig> = {}): Promise<void> {
      const ctx: ModuleContext<BrandingConfig> = {
        guildId: GUILD,
        config: { ...brandingDefaultConfig, enabled: true, ...config },
        executor,
        logger,
      };

      await listener.handler(event, ctx);
    },

    async command(config: Partial<BrandingConfig> = {}): Promise<void> {
      const ctx: CommandContext<BrandingConfig> = {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: ADMIN,
        config: { ...brandingDefaultConfig, enabled: true, ...config },
        executor,
        logger,
        options: createCommandOptions([]),
        interaction: { id: INTERACTION, token: INTERACTION_TOKEN },
        idempotencyKey: newId(),
      };

      await command.handler(ctx);
    },
  };
}

export const CHANNEL = '500000000000000001';
export const INTERACTION = '600000000000000001';
export const INTERACTION_TOKEN = 'YnJhbmRpbmctaW50ZXJhY3Rpb24.test';
