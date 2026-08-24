import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  encodeCustomId,
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
import { newChallenge } from '../src/challenge.ts';
import type { VerificationConfig } from '../src/config.ts';
import { verificationDefaultConfig } from '../src/config.ts';
import type { VerificationDeps } from '../src/deps.ts';
import { handleJoin, type JoinGateOutcome } from '../src/gate.ts';
import { createVerificationModule } from '../src/index.ts';
import { handleComponent, handleModal, type InteractionOutcome } from '../src/interactions.ts';
import { ANSWER_ACTION, CAPTCHA_ACTION, REFRESH_ACTION, VERIFY_ACTION } from '../src/panel.ts';
import { MODULE_ID } from '../src/perform.ts';
import {
  handleWebPassed,
  type PanelOutcome,
  reconcilePanel,
  type WebOutcome,
} from '../src/service.ts';
import type {
  CaptchaChallenge,
  CaptchaStore,
  PanelRecord,
  PanelStore,
  QuarantineRecord,
  QuarantineStore,
} from '../src/store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MODERATOR = '100000000000000001';
export const CHANNEL = '500000000000000001';

export const DM_CHANNEL = '500000000000000002';

export const APPLICATION = '800000000000000001';

export const INTERACTION = '600000000000000002';

export const PANEL_MESSAGE = '700000000000000001';

export const MEMBER = '400000000000000001';

export const BARE = '400000000000000002';

export const JOINER = '400000000000000003';

export const EVERYONE_ROLE = GUILD;
export const UNVERIFIED_ROLE = '410000000000000001';
export const QUARANTINE_ROLE = '410000000000000002';
export const LOW_ROLE = '410000000000000003';
export const MID_ROLE = '410000000000000004';
export const VERIFIED_ROLE = '410000000000000005';
export const BOT_ROLE = '410000000000000006';

export const ABOVE_BOT_ROLE = '410000000000000009';

export const VERIFY_LINK_SECRET = 'test-verify-link-secret-of-at-least-32-characters';

export const VERIFY_LINK_BASE_URL = 'https://proton.test';

export const CAPTCHA_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const CAPTCHA_TTL_MS = 5 * 60 * 1000;

const MESSAGE_PATH = /^\/channels\/\d+\/messages\/\d+$/;

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

export const BOT_PERMISSIONS =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.AttachFiles |
  Permissions.ManageMessages |
  Permissions.ManageRoles |
  Permissions.KickMembers |
  Permissions.BanMembers |
  Permissions.ModerateMembers;

function roles(botPermissions: bigint): Map<string, GuildRole> {
  return new Map(
    Object.entries(POSITIONS).map(([id, position]) => [
      id,
      {
        id,
        permissions: id === BOT_ROLE ? botPermissions : 0n,
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

export class MemoryCaptchaStore implements CaptchaStore {
  readonly entries = new Map<string, { challenge: CaptchaChallenge; expiresAt: number }>();

  puts = 0;
  updates = 0;

  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  async get(guildId: string, userId: string): Promise<CaptchaChallenge | null> {
    const key = `${guildId}:${userId}`;
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.#now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.challenge;
  }

  async put(challenge: CaptchaChallenge, ttlMs: number): Promise<void> {
    this.puts += 1;
    this.entries.set(`${challenge.guildId}:${challenge.userId}`, {
      challenge,
      expiresAt: this.#now() + ttlMs,
    });
  }

  // Redis KEEPTTL: the deadline survives the rewrite untouched, so a wrong answer buys no time.
  async update(challenge: CaptchaChallenge): Promise<void> {
    this.updates += 1;
    const key = `${challenge.guildId}:${challenge.userId}`;
    const expiresAt = this.entries.get(key)?.expiresAt ?? Number.POSITIVE_INFINITY;
    this.entries.set(key, { challenge, expiresAt });
  }

  async clear(guildId: string, userId: string): Promise<void> {
    this.entries.delete(`${guildId}:${userId}`);
  }

  expiryOf(guildId: string, userId: string): number | null {
    return this.entries.get(`${guildId}:${userId}`)?.expiresAt ?? null;
  }
}

export class MemoryPanelStore implements PanelStore {
  readonly records = new Map<string, PanelRecord>();

  async get(guildId: string): Promise<PanelRecord | null> {
    return this.records.get(guildId) ?? null;
  }

  async put(record: PanelRecord): Promise<void> {
    this.records.set(record.guildId, record);
  }

  async clear(guildId: string): Promise<void> {
    this.records.delete(guildId);
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  readonly memberRoles: Map<string, Set<string>>;

  readonly failures = new Map<string, RestResponse>();

  readonly refusals: Array<{
    match(call: RestRequestOptions): boolean;
    response: RestResponse;
  }> = [];

  #messages = 0;

  constructor(memberRoles: Map<string, Set<string>>) {
    this.memberRoles = memberRoles;
  }

  fail(match: (call: RestRequestOptions) => boolean, response: RestResponse): void {
    this.refusals.push({ match, response });
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);

    const failure =
      this.failures.get(options.path) ??
      this.refusals.find((refusal) => refusal.match(options))?.response;
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

    if (options.method === 'POST' && options.path === '/users/@me/channels') {
      return { status: 200, body: { id: DM_CHANNEL, type: 1 } };
    }

    if (options.method === 'POST' && /^\/channels\/\d+\/messages$/.test(options.path)) {
      this.#messages += 1;
      return { status: 200, body: { id: `70000000000000${1000 + this.#messages}` } };
    }

    if (options.method === 'PATCH' && /^\/channels\/\d+\/messages\/\d+$/.test(options.path)) {
      return { status: 200, body: { id: options.path.split('/').at(-1) } };
    }

    return { status: 204, body: {} };
  }
}

export interface RunOverrides {
  config: Partial<VerificationConfig>;

  appPermissions: bigint;

  idempotencyKey: string;

  userId: string;
}

export interface PressOverrides {
  config: Partial<VerificationConfig>;

  userId: string;

  roleIds: string[];

  deps: VerificationDeps;

  eventId: string;
}

export interface SavedOverrides extends PressOverrides {
  moduleId: string;

  enabledAfter: boolean;

  changedKeys: string[];
}

export interface SeedOverrides {
  userId: string;
  attemptsUsed: number;
  length: number;
  ttlMs: number;
}

export interface ShownMessage {
  content: string;

  components: Record<string, unknown>[];

  files: Array<{ filename: string; data: Uint8Array }>;
}

export interface ShownButton {
  label: string;
  style: number;

  customId: string | null;
  url: string | null;
}

export interface Harness {
  rest: FakeRest;
  recorder: MemoryRecorder;
  quarantine: MemoryQuarantineStore;
  captcha: MemoryCaptchaStore;
  panel: MemoryPanelStore;
  logs: Array<{ level: string; message: string }>;

  rendered: string[];

  positions: Map<string, number>;

  memberRoles: Map<string, Set<string>>;
  deps: VerificationDeps;

  now(): number;
  advance(ms: number): void;

  rolesOf(userId: string): string[];

  discordCalls(): RestRequestOptions[];

  roleCalls(): RestRequestOptions[];

  dmOpens(): RestRequestOptions[];

  sentIn(channelId: string): Array<Record<string, unknown>>;

  edits(): Array<Record<string, unknown>>;

  deleted(): Array<{ channelId: string; messageId: string }>;

  cases(): CaseInput[];

  replies(): string[];

  replyContent(): string | null;

  shown(): ShownMessage[];

  told(): string[];

  lastTold(): string | null;

  callbackTypes(): number[];

  modalOpened(): Record<string, unknown> | null;

  buttons(): ShownButton[];

  button(label: string): ShownButton;

  run(command: string, options: RawOption[], overrides?: Partial<RunOverrides>): Promise<void>;
  join(
    payload: Record<string, unknown>,
    config?: Partial<VerificationConfig>,
  ): Promise<JoinGateOutcome>;

  press(customId: string, overrides?: Partial<PressOverrides>): Promise<InteractionOutcome>;

  submit(
    customId: string,
    fields: Record<string, string>,
    overrides?: Partial<PressOverrides>,
  ): Promise<InteractionOutcome>;

  seed(overrides?: Partial<SeedOverrides>): Promise<CaptchaChallenge>;

  saved(overrides?: Partial<SavedOverrides>): Promise<PanelOutcome>;

  webPassed(
    payload: Record<string, unknown>,
    overrides?: Partial<PressOverrides>,
  ): Promise<WebOutcome>;
}

export function harness(options: { deleteRole?: string; botPermissions?: bigint } = {}): Harness {
  const positions = new Map(Object.entries(POSITIONS));
  if (options.deleteRole) positions.delete(options.deleteRole);

  const botPermissions = options.botPermissions ?? BOT_PERMISSIONS;

  const memberRoles = new Map<string, Set<string>>([
    [MEMBER, new Set([EVERYONE_ROLE, LOW_ROLE, MID_ROLE])],
    [BARE, new Set([EVERYONE_ROLE])],
    [JOINER, new Set([EVERYONE_ROLE])],
    [MODERATOR, new Set([EVERYONE_ROLE, MID_ROLE])],
  ]);

  let clock = Date.now();
  const now = (): number => clock;

  const rest = new FakeRest(memberRoles);
  const recorder = new MemoryRecorder();
  const quarantine = new MemoryQuarantineStore();
  const captcha = new MemoryCaptchaStore(now);
  const panel = new MemoryPanelStore();
  const rendered: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const dedupe = new MemoryDedupe();

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const guildState = (): GuildState => {
    const map = roles(botPermissions);

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
    captcha,
    panel,
    applicationId: APPLICATION,
    renderCaptcha: async ({ text }) => {
      rendered.push(text);
      return CAPTCHA_PNG;
    },
    verifyLinkSecret: VERIFY_LINK_SECRET,
    verifyLinkBaseUrl: VERIFY_LINK_BASE_URL,
    now,
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

  const moduleContext = (
    config: Partial<VerificationConfig> = {},
  ): ModuleContext<VerificationConfig> => ({
    guildId: GUILD,
    config: { ...verificationDefaultConfig, ...config },
    executor: executor.scoped({ channelId: CHANNEL, appPermissions: botPermissions }),
    logger,
  });

  // Discord omits @everyone from member.roles, so including it would build a payload Discord
  // never sends.
  const heldRoles = (userId: string): string[] =>
    [...(memberRoles.get(userId) ?? [])].filter((roleId) => roleId !== EVERYONE_ROLE);

  const memberEvent = (
    type: 'interaction.component' | 'interaction.modal',
    overrides: Partial<PressOverrides>,
    data: Record<string, unknown>,
  ): ProtonEvent => {
    const userId = overrides.userId ?? MEMBER;
    const component = type === 'interaction.component';

    return {
      id: overrides.eventId ?? `event-${newId()}`,
      type,
      guildId: GUILD,
      occurredAt: now(),
      payload: {
        id: INTERACTION,
        application_id: APPLICATION,
        type: component ? 3 : 5,
        token: 'interaction-token',
        guild_id: GUILD,
        channel_id: CHANNEL,
        channel: { id: CHANNEL, type: 0 },
        member: {
          user: { id: userId, username: 'presser', avatar: null, bot: false },
          roles: overrides.roleIds ?? heldRoles(userId),
          joined_at: '2026-08-15T12:00:00.000000+00:00',
        },
        app_permissions: String(botPermissions),
        ...(component ? { message: { id: PANEL_MESSAGE, channel_id: CHANNEL } } : {}),
        data,
      },
    };
  };

  const serviceEvent = (
    type: 'proton.config_changed' | 'verification.web_passed',
    payload: unknown,
    overrides: Partial<PressOverrides>,
  ): ProtonEvent => ({
    id: overrides.eventId ?? `event-${newId()}`,
    type,
    guildId: GUILD,
    occurredAt: now(),
    payload,
  });

  const discordCalls = () => rest.calls.filter((call) => !call.path.startsWith('/interactions/'));

  const replies = (): string[] =>
    rest.calls
      .filter((call) => call.path.startsWith('/interactions/'))
      .map(
        (call) => (call.body as { data?: { content?: string } } | undefined)?.data?.content ?? '',
      );

  const facing = (): RestRequestOptions[] =>
    rest.calls.filter(
      (call) => call.path.startsWith('/interactions/') || call.path.startsWith('/webhooks/'),
    );

  const shown = (): ShownMessage[] =>
    facing().map((call) => {
      const body = (call.body ?? {}) as Record<string, unknown>;
      const data = (
        call.path.startsWith('/webhooks/') ? body : ((body.data as unknown) ?? {})
      ) as Record<string, unknown>;

      return {
        content: typeof data.content === 'string' ? data.content : '',
        components: Array.isArray(data.components)
          ? (data.components as Record<string, unknown>[])
          : [],
        files: (call.files ?? []).map((file) => ({ filename: file.filename, data: file.data })),
      };
    });

  const buttons = (): ShownButton[] => {
    const message = [...shown()].reverse().find((entry) => entry.components.length > 0);
    if (!message) return [];

    return message.components
      .flatMap((row) => (Array.isArray(row.components) ? row.components : []))
      .map((raw) => {
        const component = raw as Record<string, unknown>;
        return {
          label: typeof component.label === 'string' ? component.label : '',
          style: typeof component.style === 'number' ? component.style : 0,
          customId: typeof component.custom_id === 'string' ? component.custom_id : null,
          url: typeof component.url === 'string' ? component.url : null,
        };
      });
  };

  const bodiesFor = (method: string, path: RegExp): Array<Record<string, unknown>> =>
    rest.calls
      .filter((call) => call.method === method && path.test(call.path))
      .map((call) => (call.body ?? {}) as Record<string, unknown>);

  return {
    rest,
    recorder,
    quarantine,
    captcha,
    panel,
    logs,
    rendered,
    positions,
    memberRoles,
    deps,
    now,
    advance: (ms) => {
      clock += ms;
    },
    discordCalls,
    replies,
    shown,
    buttons,
    rolesOf: (userId) => [...(memberRoles.get(userId) ?? [])],
    replyContent: () => replies().at(-1) ?? null,
    cases: () => recorder.recorded.filter((c) => c.kind !== 'interaction_reply'),

    roleCalls: () => rest.calls.filter((call) => /\/members\/\d+\/roles\/\d+$/.test(call.path)),

    dmOpens: () => rest.calls.filter((call) => call.path === '/users/@me/channels'),

    sentIn: (channelId) => bodiesFor('POST', new RegExp(`^/channels/${channelId}/messages$`)),

    edits: () => bodiesFor('PATCH', MESSAGE_PATH),

    deleted: () =>
      rest.calls
        .filter((call) => call.method === 'DELETE' && MESSAGE_PATH.test(call.path))
        .map((call) => {
          const parts = call.path.split('/');
          return { channelId: parts[2] ?? '', messageId: parts[4] ?? '' };
        }),

    told: () =>
      shown()
        .map((message) => message.content)
        .filter((content) => content.length > 0),

    lastTold: () =>
      shown()
        .map((message) => message.content)
        .filter((content) => content.length > 0)
        .at(-1) ?? null,

    callbackTypes: () =>
      rest.calls
        .filter((call) => call.path.startsWith('/interactions/'))
        .map((call) => (call.body as { type?: number } | undefined)?.type)
        .filter((type): type is number => typeof type === 'number'),

    modalOpened: () => {
      const callback = rest.calls
        .filter((call) => call.path.startsWith('/interactions/'))
        .map((call) => call.body as { type?: number; data?: Record<string, unknown> } | undefined)
        .findLast((body) => body?.type === 9);

      return callback?.data ?? null;
    },

    button(label) {
      const available = buttons();
      const found = available.find((candidate) => candidate.label === label);
      if (found) return found;

      const labels = available.map((candidate) => `'${candidate.label}'`).join(', ');
      throw new Error(
        `no button labelled '${label}' was shown to the member — only ${labels || 'nothing'}`,
      );
    },

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
          appPermissions: overrides.appPermissions ?? botPermissions,
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

      return handleJoin(event, moduleContext(config), deps);
    },

    async press(customId, overrides = {}) {
      const event = memberEvent('interaction.component', overrides, {
        custom_id: customId,
        component_type: 2,
      });

      return handleComponent(event, moduleContext(overrides.config), overrides.deps ?? deps);
    },

    async submit(customId, fields, overrides = {}) {
      const event = memberEvent('interaction.modal', overrides, {
        custom_id: customId,
        components: Object.entries(fields).map(([fieldId, value], index) => ({
          id: index + 1,
          type: 18,
          label: 'The characters in the image',
          component: { id: index + 100, type: 4, custom_id: fieldId, value },
        })),
      });

      return handleModal(event, moduleContext(overrides.config), overrides.deps ?? deps);
    },

    async seed(overrides = {}) {
      const challenge = newChallenge(
        GUILD,
        overrides.userId ?? MEMBER,
        overrides.length ?? verificationDefaultConfig.captchaLength,
        now(),
        overrides.attemptsUsed ?? 0,
      );

      await captcha.put(challenge, overrides.ttlMs ?? CAPTCHA_TTL_MS);
      return challenge;
    },

    async saved(overrides = {}) {
      const config = overrides.config ?? {};
      const auditId = newId();

      const event = serviceEvent(
        'proton.config_changed',
        {
          auditId,
          guildId: GUILD,
          moduleId: overrides.moduleId ?? MODULE_ID,
          moduleName: 'Verification',
          actorId: overrides.userId ?? MODERATOR,
          source: 'dashboard',
          enabledBefore: false,
          enabledAfter: overrides.enabledAfter ?? config.enabled ?? false,
          changedKeys: overrides.changedKeys ?? ['panelChannelId'],
        },
        { ...overrides, eventId: overrides.eventId ?? `proton.config_changed:${GUILD}:${auditId}` },
      );

      return reconcilePanel(event, moduleContext(config), overrides.deps ?? deps);
    },

    async webPassed(payload, overrides = {}) {
      const event = serviceEvent('verification.web_passed', payload, overrides);

      return handleWebPassed(event, moduleContext(overrides.config), overrides.deps ?? deps);
    },
  };
}

function customId(action: string, ...args: string[]): string {
  const encoded = encodeCustomId(MODULE_ID, action, ...args);
  if (!encoded.ok) throw new Error(encoded.humanReason);

  return encoded.customId;
}

export function verifyPress(): string {
  return customId(VERIFY_ACTION);
}

export function captchaPress(challengeId: string): string {
  return customId(CAPTCHA_ACTION, challengeId);
}

export function refreshPress(challengeId: string): string {
  return customId(REFRESH_ACTION, challengeId);
}

export function answerModal(challengeId: string): string {
  return customId(ANSWER_ACTION, challengeId);
}

export function userOption(name: string, value: string): RawOption {
  return { name, type: OptionType.User, value };
}

export function stringOption(name: string, value: string): RawOption {
  return { name, type: OptionType.String, value };
}

export function joinPayload(userId: string, roleIds: string[] = []): Record<string, unknown> {
  return {
    guild_id: GUILD,
    joined_at: '2026-08-15T12:00:00.000000+00:00',
    roles: roleIds,
    user: { id: userId, username: 'joiner', avatar: null, bot: false },
  };
}

export const GATED: Partial<VerificationConfig> = {
  enabled: true,
  unverifiedRoleId: UNVERIFIED_ROLE,
  verifiedRoleId: VERIFIED_ROLE,
};

export const PANELLED: Partial<VerificationConfig> = { ...GATED, panelChannelId: CHANNEL };

export const CAPTCHA: Partial<VerificationConfig> = { ...GATED, mode: 'captcha' };

export const WEBSITE: Partial<VerificationConfig> = { ...GATED, mode: 'website' };

export const QUARANTINED: Partial<VerificationConfig> = {
  enabled: true,
  quarantineRoleId: QUARANTINE_ROLE,
};
