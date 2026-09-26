import {
  type ActionExecutor,
  type ActionFailure,
  type ActionRequest,
  type ActionResult,
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type EntitlementTier,
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
  ProviderRegistry,
  type RawOption,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
  type ScheduleOptions,
  type ScheduleOutcome,
} from '@proton/core';
import { ComponentType, InteractionType } from 'discord-api-types/v10';
import { applyCommand } from '../src/commands/apply.ts';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type FormConfig,
  formSchema,
  type PanelConfig,
  panelSchema,
} from '../src/config.ts';
import type { ApplicationsDeps } from '../src/deps.ts';
import {
  createApplicationsAutocompleteListener,
  createApplicationsInteractionListener,
} from '../src/interactions.ts';
import { snapshotOf } from '../src/version.ts';
import { MemoryApplicationStore } from './memory-store.ts';

export const GUILD = '900000000000000001';
export const OWNER = '200000000000000001';
export const BOT = '300000000000000001';
export const MEMBER = '400000000000000001';
export const STRANGER = '400000000000000002';
export const ADMIN = '400000000000000009';

export const MEMBER_ROLE = '410000000000000001';
export const BLOCKED_ROLE = '410000000000000002';
const BOT_ROLE = '410000000000000005';

export const PANEL_CHANNEL = '500000000000000001';
export const REVIEW_CHANNEL = '500000000000000002';
export const PANEL_MESSAGE = '700000000000000001';
export const PRIVATE_MESSAGE = '700000000000000002';

export const START = Date.UTC(2026, 8, 24, 12, 0, 0);
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

const EPHEMERAL = 64;
const V2 = 32768;
const INITIAL_CALLBACKS: ReadonlySet<number> = new Set([4, 5, 6, 7, 9]);

const BOT_PERMISSIONS = Permissions.ViewChannel | Permissions.SendMessages | Permissions.EmbedLinks;

let sequence = 0;
const tick = (): number => {
  sequence += 1;
  return sequence;
};

let interactionCounter = 0;

export {
  handleApplicantInteraction,
  overviewFor,
  resumeAt,
  standingOf,
} from '../src/flow.ts';
export {
  applyCommand,
  createApplicationsAutocompleteListener,
  createApplicationsInteractionListener,
};

export function moderatorForm(overrides: Record<string, unknown> = {}): FormConfig {
  return formSchema.parse({
    id: 'mods',
    name: 'Moderator Application',
    description: 'Help keep the server friendly.',
    intro: 'Tell us about yourself. It takes about five minutes.',
    confirmation: 'Staff usually reply within a week.',
    sections: [
      {
        id: 'about',
        title: 'About you',
        questions: [
          {
            id: 'age',
            type: 'number',
            label: 'How old are you?',
            min: 13,
            max: 120,
            integer: true,
          },
          {
            id: 'why',
            type: 'paragraph',
            label: 'Why do you want to help?',
            help: 'A few sentences is plenty.',
            minLength: 10,
          },
          {
            id: 'track',
            type: 'single',
            label: 'Which team?',
            options: [
              { value: 'dev', label: 'Developers' },
              { value: 'mod', label: 'Moderators' },
              { value: 'events', label: 'Events' },
            ],
          },
          {
            id: 'portfolio',
            type: 'url',
            label: 'Link to your work',
            showIf: { questionId: 'track', values: ['dev'] },
          },
        ],
      },
      {
        id: 'experience',
        title: 'Experience',
        questions: [
          {
            id: 'tools',
            type: 'multiple',
            label: 'Tools you have used',
            required: false,
            options: [
              { value: 'automod', label: 'AutoMod' },
              { value: 'bots', label: 'Moderation bots' },
              { value: 'logs', label: 'Audit logs' },
            ],
          },
          { id: 'rules', type: 'confirm', label: 'I have read the server rules' },
        ],
      },
    ],
    intake: { open: true, cooldownDays: 0, maxActive: 1 },
    ...overrides,
  });
}

export function panelOf(overrides: Record<string, unknown> = {}): PanelConfig {
  return panelSchema.parse({
    id: 'staff',
    name: 'Staff panel',
    channelId: PANEL_CHANNEL,
    formIds: ['mods'],
    ...overrides,
  });
}

export const GOOD_ANSWERS = {
  age: '21',
  why: 'I like helping people and I am online most evenings.',
  track: 'mod',
} as const;

function guildState(): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map<string, GuildRole>([
      [GUILD, { id: GUILD, permissions: Permissions.ViewChannel, position: 0 }],
      [MEMBER_ROLE, { id: MEMBER_ROLE, permissions: 0n, position: 1 }],
      [BLOCKED_ROLE, { id: BLOCKED_ROLE, permissions: 0n, position: 2 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: BOT_PERMISSIONS, position: 5 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(
      [PANEL_CHANNEL, REVIEW_CHANNEL].map((id) => [
        id,
        { id, type: 0, parentId: null, overwrites: [] },
      ]),
    ),
    updatedAt: START,
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

export interface RestCall extends RestRequestOptions {
  at: number;
}

export type RouteMatcher = string | ((call: RestRequestOptions) => boolean);

export class FakeRest implements RestProxyClient {
  readonly calls: RestCall[] = [];
  readonly #scripted: Array<{ match: RouteMatcher; response: RestResponse }> = [];
  readonly #acknowledged = new Set<string>();

  fail(match: RouteMatcher, response: RestResponse): void {
    this.#scripted.push({ match, response });
  }

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push({ ...options, at: tick() });

    const scripted = this.#scripted.find((entry) =>
      typeof entry.match === 'string' ? options.path.includes(entry.match) : entry.match(options),
    );
    if (scripted) return scripted.response;

    if (!options.path.startsWith('/interactions/')) {
      return { status: 200, body: { id: newId(), channel_id: PANEL_CHANNEL } };
    }

    const interactionId = options.path.split('/')[2] ?? '';
    const type = (options.body as { type?: number } | undefined)?.type ?? 0;
    if (!INITIAL_CALLBACKS.has(type)) return { status: 204, body: null };
    if (this.#acknowledged.has(interactionId)) {
      return {
        status: 400,
        body: { code: 40060, message: 'Interaction has already been acknowledged.' },
      };
    }
    this.#acknowledged.add(interactionId);
    return { status: 204, body: null };
  }
}

export interface Executed {
  request: ActionRequest;
  result: ActionResult;
}

class RecordingExecutor implements ActionExecutor {
  readonly #inner: ActionExecutor;
  readonly #log: Executed[];

  constructor(inner: ActionExecutor, log: Executed[]) {
    this.#inner = inner;
    this.#log = log;
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const result = await this.#inner.execute(request);
    this.#log.push({ request, result });
    return result;
  }

  async precheck(request: ActionRequest): Promise<ActionFailure | null> {
    return (await this.#inner.precheck?.(request)) ?? null;
  }
}

export type ModalAnswer = string | readonly string[] | boolean | null;

export interface PressOptions {
  userId?: string;
  roleIds?: string[];
  joinedAt?: string | null;
  panel?: boolean;
  values?: string[];
  componentType?: number;
  eventId?: string;
  occurredAt?: number;
}

export interface Delivered {
  event: ProtonEvent;
  interactionId: string;
}

export interface Button {
  label: string;
  customId: string | null;
  url: string | null;
  style: number;
  disabled: boolean;
}

export interface ModalData {
  custom_id: string;
  title: string;
  components: Array<Record<string, unknown>>;
}

export interface HarnessOptions {
  store?: MemoryApplicationStore;
  forms?: FormConfig[];
  panels?: PanelConfig[];
  config?: Record<string, unknown>;
  publish?: boolean;
  now?: number;
  deps?: Partial<ApplicationsDeps>;
  withoutStore?: boolean;
  tier?: EntitlementTier;
}

function walk(nodes: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const entry = node as Record<string, unknown>;
    visit(entry);
    walk(entry.components, visit);
    if (entry.accessory) walk([entry.accessory], visit);
    if (entry.component) walk([entry.component], visit);
  }
}

export function textsOf(components: unknown): string[] {
  const found: string[] = [];
  walk(components, (node) => {
    if (node.type === ComponentType.TextDisplay && typeof node.content === 'string') {
      found.push(node.content);
    }
  });
  return found;
}

export function buttonsOf(components: unknown): Button[] {
  const found: Button[] = [];
  walk(components, (node) => {
    if (node.type !== ComponentType.Button) return;
    found.push({
      label: typeof node.label === 'string' ? node.label : '',
      customId: typeof node.custom_id === 'string' ? node.custom_id : null,
      url: typeof node.url === 'string' ? node.url : null,
      style: typeof node.style === 'number' ? node.style : 0,
      disabled: node.disabled === true,
    });
  });
  return found;
}

export function customIdsOf(components: unknown): string[] {
  const found: string[] = [];
  walk(components, (node) => {
    if (typeof node.custom_id === 'string') found.push(node.custom_id);
  });
  return found;
}

export function countComponents(components: unknown): number {
  let count = 0;
  walk(components, () => {
    count += 1;
  });
  return count;
}

function submission(modal: ModalData, answers: Readonly<Record<string, ModalAnswer>>): unknown[] {
  return modal.components.map((label, index) => {
    const inner = (label.component ?? {}) as Record<string, unknown>;
    const id = String(inner.custom_id);
    const given = Object.hasOwn(answers, id) ? answers[id] : undefined;

    let component: Record<string, unknown>;
    switch (inner.type) {
      case ComponentType.TextInput:
        component = {
          type: inner.type,
          custom_id: id,
          value: typeof given === 'string' ? given : '',
        };
        break;
      case ComponentType.RadioGroup:
        component = {
          type: inner.type,
          custom_id: id,
          value: typeof given === 'string' ? given : null,
        };
        break;
      case ComponentType.CheckboxGroup:
      case ComponentType.StringSelect:
        component = {
          type: inner.type,
          custom_id: id,
          values:
            given === true
              ? ['yes']
              : typeof given === 'string'
                ? [given]
                : Array.isArray(given)
                  ? [...given]
                  : [],
        };
        break;
      default:
        component = { type: inner.type, custom_id: id };
    }

    return {
      id: index + 1,
      type: ComponentType.Label,
      component: { id: index + 100, ...component },
    };
  });
}

export function harness(options: HarnessOptions = {}) {
  let clock = options.now ?? START;

  const rest = new FakeRest();
  const store = options.store ?? new MemoryApplicationStore({ now: () => clock });
  if (options.store) store.setClock(() => clock);

  const executed: Executed[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const published: Array<{ type: string; naturalKey: string; payload: unknown }> = [];
  const scheduled: Array<{ jobId: string; runAt: Date; naturalKey: string; data: unknown }> = [];
  const events: Delivered[] = [];

  const logger: Logger = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
    error: (message) => logs.push({ level: 'error', message }),
  };

  const state: GuildStateStore = {
    get: async () => guildState(),
    put: async () => undefined,
    patch: async () => undefined,
    delete: async () => undefined,
  };

  const executor = new RecordingExecutor(
    new DefaultActionExecutor({
      dedupe: new MemoryDedupe(),
      rest,
      recorder: new MemoryRecorder(),
      resolveContext: async (
        request,
        hints,
      ): Promise<PrecheckInput | { failure: { code: string; humanReason: string } }> => {
        const resolved = await resolvePrecheckContext(
          { store: state, botUserId: BOT, fetchMemberRoles: async () => [] },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    }).scoped({ channelId: PANEL_CHANNEL, appPermissions: BOT_PERMISSIONS }),
    executed,
  );

  const forms = options.forms ?? [moderatorForm()];
  let config: ApplicationsConfig = applicationsConfigSchema.parse({
    enabled: true,
    forms,
    panels: options.panels ?? [panelOf({ formIds: forms.map((form) => form.id).slice(0, 10) })],
    ...options.config,
  });

  const deps: ApplicationsDeps = {
    store,
    applicationId: BOT,
    dashboardUrl: 'https://prtn.xyz',
    providers: new ProviderRegistry(),
    availability: { isEnabled: async () => true },
    now: () => clock,
    ...options.deps,
  };
  if (options.withoutStore) delete deps.store;

  const context = (): ModuleContext<ApplicationsConfig> => ({
    guildId: GUILD,
    config,
    tier: options.tier ?? 'free',
    executor,
    logger,
    publish: async (type, naturalKey, payload) => {
      published.push({ type, naturalKey, payload });
    },
    schedule: async (
      jobId: string,
      runAt: Date,
      naturalKey: string,
      data?: unknown,
      _options?: ScheduleOptions,
    ): Promise<ScheduleOutcome> => {
      scheduled.push({ jobId, runAt, naturalKey, data });
      return { scheduled: true, replaced: false };
    },
    cancel: async () => undefined,
  });

  const nextInteraction = (): string => {
    interactionCounter += 1;
    return String(600_000_000_000_000_000n + BigInt(interactionCounter));
  };

  const memberOf = (opts: PressOptions): Record<string, unknown> => ({
    user: { id: opts.userId ?? MEMBER, username: 'applicant', global_name: 'Applicant' },
    roles: opts.roleIds ?? [MEMBER_ROLE],
    permissions: '0',
    joined_at: opts.joinedAt === undefined ? '2025-01-01T00:00:00.000000+00:00' : opts.joinedAt,
  });

  const base = (
    interactionId: string,
    type: number,
    opts: PressOptions,
  ): Record<string, unknown> => ({
    id: interactionId,
    application_id: BOT,
    type,
    token: `token-${interactionId}`,
    guild_id: GUILD,
    channel_id: PANEL_CHANNEL,
    member: memberOf(opts),
    app_permissions: String(BOT_PERMISSIONS),
  });

  const listener = () => createApplicationsInteractionListener(deps);

  const deliver = async (event: ProtonEvent, interactionId: string): Promise<Delivered> => {
    const delivered = { event, interactionId };
    events.push(delivered);
    await listener().handler(event, context());
    return delivered;
  };

  const componentEvent = (customId: string, opts: PressOptions = {}): Delivered => {
    const interactionId = nextInteraction();
    const event: ProtonEvent = {
      id: opts.eventId ?? `interaction.component:${interactionId}`,
      type: 'interaction.component',
      guildId: GUILD,
      occurredAt: opts.occurredAt ?? clock,
      payload: {
        ...base(interactionId, InteractionType.MessageComponent, opts),
        message: opts.panel
          ? { id: PANEL_MESSAGE, channel_id: PANEL_CHANNEL, flags: V2 }
          : { id: PRIVATE_MESSAGE, channel_id: PANEL_CHANNEL, flags: V2 | EPHEMERAL },
        data: {
          custom_id: customId,
          component_type:
            opts.componentType ??
            (opts.values === undefined ? ComponentType.Button : ComponentType.StringSelect),
          ...(opts.values === undefined ? {} : { values: opts.values }),
        },
      },
    };
    return { event, interactionId };
  };

  const modalEvent = (
    customId: string,
    components: unknown[],
    opts: PressOptions & { withoutMessage?: boolean } = {},
  ): Delivered => {
    const interactionId = nextInteraction();
    const event: ProtonEvent = {
      id: opts.eventId ?? `interaction.modal:${interactionId}`,
      type: 'interaction.modal',
      guildId: GUILD,
      occurredAt: opts.occurredAt ?? clock,
      payload: {
        ...base(interactionId, InteractionType.ModalSubmit, opts),
        ...(opts.withoutMessage
          ? {}
          : { message: { id: PRIVATE_MESSAGE, channel_id: PANEL_CHANNEL, flags: V2 | EPHEMERAL } }),
        data: { custom_id: customId, components },
      },
    };
    return { event, interactionId };
  };

  const dataOf = (call: RestRequestOptions): Record<string, unknown> => {
    const body = (call.body ?? {}) as Record<string, unknown>;
    return call.path.startsWith('/interactions/')
      ? ((body.data as Record<string, unknown> | undefined) ?? {})
      : body;
  };

  const facing = (): RestCall[] =>
    rest.calls.filter(
      (call) => call.path.startsWith('/interactions/') || call.path.startsWith('/webhooks/'),
    );

  const callsFor = (interactionId: string): RestCall[] =>
    facing().filter((call) => call.path.includes(interactionId));

  const callbackTypesFor = (interactionId: string): number[] =>
    callsFor(interactionId)
      .filter((call) => call.path.startsWith('/interactions/'))
      .map((call) => (call.body as { type?: number } | undefined)?.type ?? 0);

  const lastScreen = (): Record<string, unknown>[] => {
    const last = facing()
      .filter((call) => (call.body as { type?: number } | undefined)?.type !== 9)
      .map(dataOf)
      .filter((data) => Array.isArray(data.components) && data.components.length > 0)
      .at(-1);
    return (last?.components as Record<string, unknown>[] | undefined) ?? [];
  };

  const lastModal = (): ModalData | null => {
    const opened = facing()
      .filter((call) => call.path.startsWith('/interactions/'))
      .map((call) => call.body as { type?: number; data?: ModalData } | undefined)
      .findLast((body) => body?.type === 9);
    return opened?.data ?? null;
  };

  const statuses = (): string[] =>
    facing()
      .flatMap((call) => (dataOf(call).embeds ?? []) as Array<{ description?: string }>)
      .map((embed) => embed.description)
      .filter((description): description is string => typeof description === 'string');

  const findButton = (label: string | RegExp): Button => {
    const buttons = buttonsOf(lastScreen());
    const found = buttons.find((button) =>
      typeof label === 'string' ? button.label === label : label.test(button.label),
    );
    if (!found) {
      throw new Error(
        `no button '${String(label)}' on the last screen; saw ${buttons.map((b) => `'${b.label}'`).join(', ')}`,
      );
    }
    return found;
  };

  const self = {
    rest,
    store,
    deps,
    executed,
    logs,
    published,
    scheduled,
    events,

    get config(): ApplicationsConfig {
      return config;
    },
    setConfig(next: Record<string, unknown>): void {
      config = applicationsConfigSchema.parse(next);
    },
    reconfigure(change: (current: ApplicationsConfig) => Record<string, unknown>): void {
      config = applicationsConfigSchema.parse(change(config));
    },

    now: (): number => clock,
    advance(ms: number): void {
      clock += ms;
    },

    context,

    async publishForms(which: readonly FormConfig[] = config.forms): Promise<void> {
      for (const form of which) {
        await store.publish({
          guildId: GUILD,
          formId: form.id,
          snapshot: snapshotOf(form),
          draftPolicy: 'keep',
          publishedBy: ADMIN,
          audit: {
            actorId: ADMIN,
            source: 'dashboard',
            action: 'module.applications.publish',
            id: `applications.publish:${GUILD}:${newId()}`,
          },
        });
      }
    },

    async press(customId: string, opts: PressOptions = {}): Promise<Delivered> {
      const built = componentEvent(customId, opts);
      return deliver(built.event, built.interactionId);
    },

    async select(customId: string, values: string[], opts: PressOptions = {}): Promise<Delivered> {
      const built = componentEvent(customId, { ...opts, values });
      return deliver(built.event, built.interactionId);
    },

    async pressButton(label: string | RegExp, opts: PressOptions = {}): Promise<Delivered> {
      const button = findButton(label);
      if (button.customId === null) throw new Error(`'${button.label}' is a link button`);
      return self.press(button.customId, opts);
    },

    async submitModal(
      answers: Readonly<Record<string, ModalAnswer>>,
      opts: PressOptions & { withoutMessage?: boolean; modal?: ModalData } = {},
    ): Promise<Delivered> {
      const modal = opts.modal ?? lastModal();
      if (!modal) throw new Error('no modal was opened');
      const built = modalEvent(modal.custom_id, submission(modal, answers), opts);
      return deliver(built.event, built.interactionId);
    },

    async submitRaw(
      customId: string,
      components: unknown[],
      opts: PressOptions & { withoutMessage?: boolean } = {},
    ): Promise<Delivered> {
      const built = modalEvent(customId, components, opts);
      return deliver(built.event, built.interactionId);
    },

    async redeliver(delivered: Delivered): Promise<void> {
      events.push(delivered);
      await listener().handler(delivered.event, context());
    },

    async command(
      sub: string,
      options: RawOption[] = [],
      opts: PressOptions & { permissions?: bigint } = {},
    ): Promise<string> {
      const interactionId = nextInteraction();
      const joined = opts.joinedAt === undefined ? '2025-01-01T00:00:00.000Z' : opts.joinedAt;
      const ctx: CommandContext<ApplicationsConfig> = {
        ...context(),
        channelId: PANEL_CHANNEL,
        userId: opts.userId ?? MEMBER,
        actorRoleIds: opts.roleIds ?? [MEMBER_ROLE],
        actorPermissions: opts.permissions ?? 0n,
        actorNick: null,
        actorJoinedAt: joined === null ? null : Date.parse(joined),
        options: createCommandOptions([{ name: sub, type: OptionType.Subcommand, options }]),
        interaction: { id: interactionId, token: `token-${interactionId}` },
        applicationId: BOT,
        idempotencyKey: opts.eventId ?? `interaction.command:${interactionId}`,
      };
      await applyCommand(deps).handler(ctx);
      return interactionId;
    },

    async autocomplete(
      sub: string,
      focused: { name: string; value: string },
      opts: PressOptions = {},
    ): Promise<Array<{ name: string; value: string }>> {
      const interactionId = nextInteraction();
      const event: ProtonEvent = {
        id: `interaction.autocomplete:${interactionId}`,
        type: 'interaction.autocomplete',
        guildId: GUILD,
        occurredAt: clock,
        payload: {
          ...base(interactionId, InteractionType.ApplicationCommandAutocomplete, opts),
          data: {
            name: 'apply',
            type: 1,
            options: [
              {
                name: sub,
                type: OptionType.Subcommand,
                options: [
                  {
                    name: focused.name,
                    type: OptionType.String,
                    value: focused.value,
                    focused: true,
                  },
                ],
              },
            ],
          },
        },
      };
      await createApplicationsAutocompleteListener(deps).handler(event, context());
      const answer = callsFor(interactionId).at(-1);
      const data = answer === undefined ? {} : dataOf(answer);
      return (data.choices as Array<{ name: string; value: string }> | undefined) ?? [];
    },

    facing,
    callsFor,
    callbackTypesFor,
    initialCallbacksFor: (interactionId: string): number[] =>
      callbackTypesFor(interactionId).filter((type) => INITIAL_CALLBACKS.has(type)),
    dataOf,
    lastScreen,
    lastModal,
    texts: (): string[] => textsOf(lastScreen()),
    text: (): string => textsOf(lastScreen()).join('\n'),
    buttons: (): Button[] => buttonsOf(lastScreen()),
    button: findButton,
    statuses,
    lastStatus: (): string | null => statuses().at(-1) ?? null,
    failures: (): Executed[] =>
      executed.filter(
        (entry) =>
          entry.result.status === 'failed_precheck' || entry.result.status === 'failed_api',
      ),
    draft() {
      const drafts = [...store.applicationsById.values()].filter(
        (application) => application.applicantId === MEMBER && application.status === 'draft',
      );
      if (drafts.length !== 1) throw new Error(`expected one draft, found ${drafts.length}`);
      return drafts[0] as NonNullable<(typeof drafts)[number]>;
    },
  };

  return self;
}

export type Harness = ReturnType<typeof harness>;

export async function ready(options: HarnessOptions = {}): Promise<Harness> {
  const built = harness(options);
  if (options.publish !== false) await built.publishForms();
  return built;
}
