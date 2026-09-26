import {
  type ActionRequest,
  type ActionResult,
  type CommandContext,
  type EventType,
  type ModuleContext,
  Permissions,
  type ProtonEvent,
  toRestCall,
} from '@proton/core';
import { ComponentType } from 'discord-api-types/v10';
import type { z } from 'zod';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type FormConfig,
  formSchema,
} from '../src/config.ts';
import type { BoundApplicationsDeps } from '../src/deps.ts';
import { readCustomId } from '../src/interface.ts';
import type { CheckedAnswer } from '../src/questions.ts';
import * as staff from '../src/staff.ts';
import type { ApplicationRecord } from '../src/store.ts';
import { snapshotOf } from '../src/version.ts';
import { applicationRecord, MemoryApplicationStore } from './memory-store.ts';

export * as review from '../src/commands/review.ts';
export { staff };

export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const APPLICANT = '400000000000000001';
export const REVIEWER = '100000000000000001';
export const SECOND = '100000000000000002';
export const DECIDER = '100000000000000003';
export const OUTSIDER = '100000000000000009';
export const ADMIN = '100000000000000010';

export const REVIEWER_ROLE = '410000000000000001';
export const DECIDER_ROLE = '410000000000000002';
export const OVERRIDE_ROLE = '410000000000000003';
export const VIEWER_ROLE = '410000000000000004';

export const APPLICATION = '300000000000000009';
export const REVIEW_CHANNEL = '500000000000000001';
export const CARD_MESSAGE = '1400000000000000001';
export const DASHBOARD = 'https://prtn.xyz';
export const NOW = 1_700_000_000_000;

export const APP_ID = '01JAPPLICATION00000000000A';
export const VERSION_ID = 'version-1';

export const EPHEMERAL = 64;
export const COMPONENTS_V2 = 32768;

export const QUESTIONS = [
  { id: 'why', type: 'paragraph', label: 'Why do you want to help?' },
  { id: 'hours', type: 'number', label: 'Hours a week', required: false },
  { id: 'site', type: 'url', label: 'Portfolio', required: false },
  { id: 'agree', type: 'confirm', label: 'I have read the rules' },
] as const;

export function formConfig(overrides: Partial<z.input<typeof formSchema>> = {}): FormConfig {
  return formSchema.parse({
    id: 'mods',
    name: 'Moderator Application',
    sections: [{ id: 'about', title: 'About you', questions: QUESTIONS }],
    intake: { open: true },
    ...overrides,
  });
}

export function configWith(
  overrides: Partial<z.input<typeof applicationsConfigSchema>> = {},
): ApplicationsConfig {
  return applicationsConfigSchema.parse({
    enabled: true,
    reviewChannelId: REVIEW_CHANNEL,
    reviewerRoleIds: [REVIEWER_ROLE],
    deciderRoleIds: [DECIDER_ROLE, REVIEWER_ROLE],
    viewerRoleIds: [VIEWER_ROLE],
    overrideRoleIds: [OVERRIDE_ROLE],
    forms: [formConfig()],
    ...overrides,
  });
}

export function answers(): CheckedAnswer[] {
  return [
    {
      questionId: 'why',
      sectionId: 'about',
      label: 'Why do you want to help?',
      type: 'paragraph',
      value: 'I like keeping **places** tidy. `rm -rf` @everyone <@1>',
      display: 'I like keeping **places** tidy. `rm -rf` @everyone <@1>',
    },
    {
      questionId: 'hours',
      sectionId: 'about',
      label: 'Hours a week',
      type: 'number',
      value: '10',
      display: '10',
    },
    {
      questionId: 'agree',
      sectionId: 'about',
      label: 'I have read the rules',
      type: 'confirm',
      value: true,
      display: 'Confirmed',
    },
  ];
}

export interface Call {
  request: ActionRequest;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  status: ActionResult['status'];
}

export interface Actor {
  userId?: string;
  roleIds?: string[];
  permissions?: bigint;
}

export interface PressOptions extends Actor {
  values?: string[];
  messageFlags?: number | null;
  interactionId?: string;
  guildId?: string;
}

export interface SubmitOptions extends Actor {
  fields?: Record<string, string>;
  radios?: Record<string, string | null>;
  checks?: Record<string, boolean>;
  interactionId?: string;
}

const MEMBER_ROLES: Readonly<Record<string, string[]>> = {
  [REVIEWER]: [REVIEWER_ROLE],
  [SECOND]: [REVIEWER_ROLE],
  [DECIDER]: [DECIDER_ROLE],
  [OUTSIDER]: [],
  [APPLICANT]: [REVIEWER_ROLE],
  [ADMIN]: [],
};

export class Harness {
  readonly store = new MemoryApplicationStore({ now: () => NOW });
  readonly calls: Call[] = [];
  readonly logs: { level: string; message: string }[] = [];
  readonly published: { type: EventType; naturalKey: string }[] = [];
  readonly invalid: string[] = [];
  readonly refusals = new Map<string, ActionResult>();
  readonly members = new Map<string, string[] | 'absent' | 'unavailable'>(
    Object.entries(MEMBER_ROLES),
  );

  config: ApplicationsConfig;
  ctx: ModuleContext<ApplicationsConfig>;
  deps: BoundApplicationsDeps;

  #held = new Set<string>();
  #interactions = 0;

  constructor(config: ApplicationsConfig = configWith()) {
    this.config = config;

    const current = (): ApplicationsConfig => this.config;
    const executor = {
      execute: async (request: ActionRequest): Promise<ActionResult> => this.#execute(request),
    };
    const log =
      (level: string) =>
      (message: string): void => {
        this.logs.push({ level, message });
      };

    this.ctx = {
      guildId: GUILD,
      get config(): ApplicationsConfig {
        return current();
      },
      tier: 'free',
      executor,
      logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      publish: async (type: EventType, naturalKey: string) => {
        this.published.push({ type, naturalKey });
      },
    } as unknown as ModuleContext<ApplicationsConfig>;

    this.deps = {
      store: this.store,
      applicationId: APPLICATION,
      dashboardUrl: DASHBOARD,
      providers: null,
      availability: { isEnabled: async () => true },
      guildState: null,
      placeholders: null,
      memberRoles: null,
      lookupMember: async (_guildId, userId) => {
        const held = this.members.get(userId) ?? 'absent';
        if (held === 'absent' || held === 'unavailable') return { state: held };
        return { state: 'member', roleIds: [...held], joinedAt: null };
      },
      now: () => NOW,
    };
  }

  #execute(request: ActionRequest): ActionResult {
    const mapped = toRestCall(request);
    if ('error' in mapped) this.invalid.push(`${request.kind}: ${mapped.error}`);

    let result: ActionResult;
    const refusal = this.refusals.get(request.kind);
    if (this.#held.has(request.idempotencyKey)) {
      result = { status: 'skipped_duplicate' };
    } else if (refusal !== undefined) {
      result = refusal;
    } else {
      this.#held.add(request.idempotencyKey);
      result =
        request.kind === 'send' || request.kind === 'interaction_followup'
          ? { status: 'executed', body: { id: CARD_MESSAGE } }
          : { status: 'executed' };
    }

    this.calls.push({
      request,
      kind: request.kind,
      key: request.idempotencyKey,
      payload: (request.payload ?? {}) as Record<string, unknown>,
      status: result.status,
    });
    return result;
  }

  setConfig(config: ApplicationsConfig): void {
    this.config = config;
  }

  form(): FormConfig {
    const [form] = this.config.forms;
    if (form === undefined) throw new Error('the harness config has no form');
    return form;
  }

  seed(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
    const form = this.form();
    this.store.seedVersion({
      id: VERSION_ID,
      guildId: GUILD,
      formId: form.id,
      version: 1,
      snapshot: snapshotOf(form),
      draftPolicy: 'keep',
      publishedBy: ADMIN,
      publishedAt: NOW - 10_000,
    });
    return this.store.seedApplication(
      applicationRecord({
        id: APP_ID,
        guildId: GUILD,
        number: 12,
        formId: form.id,
        versionId: VERSION_ID,
        applicantId: APPLICANT,
        applicantName: 'Applicant',
        status: 'submitted',
        revision: 1,
        answers: answers(),
        submittedAt: NOW - 3_600_000,
        ...overrides,
      }),
    );
  }

  nextInteraction(): string {
    this.#interactions += 1;
    return String(600000000000000000n + BigInt(this.#interactions));
  }

  #member(actor: Actor): Record<string, unknown> {
    const userId = actor.userId ?? REVIEWER;
    const permissions =
      actor.permissions ?? (userId === ADMIN ? Permissions.ManageGuild : Permissions.ViewChannel);
    return {
      user: { id: userId },
      roles: actor.roleIds ?? MEMBER_ROLES[userId] ?? [],
      permissions: String(permissions),
    };
  }

  press(customId: string, options: PressOptions = {}): ProtonEvent {
    const interactionId = options.interactionId ?? this.nextInteraction();
    const flags = options.messageFlags === undefined ? COMPONENTS_V2 : options.messageFlags;
    return {
      id: `interaction.component:${interactionId}`,
      type: 'interaction.component',
      guildId: options.guildId ?? GUILD,
      occurredAt: NOW,
      payload: {
        id: interactionId,
        token: `token-${interactionId}`,
        type: 3,
        application_id: APPLICATION,
        guild_id: options.guildId ?? GUILD,
        channel_id: REVIEW_CHANNEL,
        member: this.#member(options),
        data: {
          custom_id: customId,
          component_type:
            options.values === undefined ? ComponentType.Button : ComponentType.StringSelect,
          ...(options.values === undefined ? {} : { values: options.values }),
        },
        message: { id: CARD_MESSAGE, ...(flags === null ? {} : { flags }) },
      },
    };
  }

  submit(customId: string, options: SubmitOptions = {}): ProtonEvent {
    const interactionId = options.interactionId ?? this.nextInteraction();
    const labelled = (component: Record<string, unknown>) => ({
      type: ComponentType.Label,
      component,
    });
    const components = [
      ...Object.entries(options.fields ?? {}).map(([id, value]) =>
        labelled({ type: ComponentType.TextInput, custom_id: id, value }),
      ),
      ...Object.entries(options.radios ?? {}).map(([id, value]) =>
        labelled({ type: ComponentType.RadioGroup, custom_id: id, value }),
      ),
      ...Object.entries(options.checks ?? {}).map(([id, value]) =>
        labelled({ type: ComponentType.Checkbox, custom_id: id, value }),
      ),
    ];

    return {
      id: `interaction.modal:${interactionId}`,
      type: 'interaction.modal',
      guildId: GUILD,
      occurredAt: NOW,
      payload: {
        id: interactionId,
        token: `token-${interactionId}`,
        type: 5,
        application_id: APPLICATION,
        guild_id: GUILD,
        channel_id: REVIEW_CHANNEL,
        member: this.#member(options),
        data: { custom_id: customId, components },
        message: { id: CARD_MESSAGE, flags: COMPONENTS_V2 },
      },
    };
  }

  async run(event: ProtonEvent): Promise<void> {
    const payload = event.payload as { data: { custom_id: string } };
    const parsed = readCustomId(payload.data.custom_id);
    if (parsed === null) {
      throw new Error(`not an applications custom id: ${payload.data.custom_id}`);
    }
    await staff.handleStaffInteraction(event, this.ctx, this.deps, parsed);
  }

  since(mark: number): Call[] {
    return this.calls.slice(mark);
  }

  answersTo(event: ProtonEvent): Call[] {
    const interactionId = (event.payload as { id: string }).id;
    return this.calls.filter((call) => {
      const payload = call.payload;
      return (
        payload.interactionId === interactionId ||
        (typeof payload.interactionToken === 'string' &&
          payload.interactionToken === `token-${interactionId}`)
      );
    });
  }

  command(options: {
    subcommand: 'queue' | 'view';
    number?: number;
    userId?: string;
    roleIds?: string[];
    permissions?: bigint;
  }): CommandContext<ApplicationsConfig> {
    const interactionId = this.nextInteraction();
    const userId = options.userId ?? REVIEWER;
    return {
      ...this.ctx,
      config: this.config,
      channelId: REVIEW_CHANNEL,
      userId,
      actorRoleIds: options.roleIds ?? MEMBER_ROLES[userId] ?? [],
      actorPermissions:
        options.permissions ??
        (userId === ADMIN ? Permissions.ManageGuild : Permissions.ViewChannel),
      options: {
        getString: () => null,
        getInteger: (name: string) => (name === 'number' ? (options.number ?? null) : null),
        getNumber: () => null,
        getBoolean: () => null,
        getUserId: () => null,
        getChannelId: () => null,
        getRoleId: () => null,
        getAttachment: () => null,
        getSubcommand: () => options.subcommand,
        getSubcommandGroup: () => null,
        has: (name: string) => name === 'number' && options.number !== undefined,
      },
      interaction: { id: interactionId, token: `token-${interactionId}` },
      applicationId: APPLICATION,
      idempotencyKey: `interaction.command:${interactionId}`,
    };
  }
}

type Component = Record<string, unknown>;

export function walk(components: readonly unknown[], visit: (component: Component) => void): void {
  for (const raw of components) {
    if (typeof raw !== 'object' || raw === null) continue;
    const component = raw as Component;
    visit(component);
    if (Array.isArray(component.components)) walk(component.components, visit);
    if (typeof component.accessory === 'object' && component.accessory !== null) {
      walk([component.accessory], visit);
    }
    if (typeof component.component === 'object' && component.component !== null) {
      walk([component.component], visit);
    }
  }
}

export function textOf(components: readonly unknown[]): string {
  const parts: string[] = [];
  walk(components, (component) => {
    if (component.type === ComponentType.TextDisplay && typeof component.content === 'string') {
      parts.push(component.content);
    }
  });
  return parts.join('\n');
}

export function customIds(components: readonly unknown[]): string[] {
  const ids: string[] = [];
  walk(components, (component) => {
    if (typeof component.custom_id === 'string') ids.push(component.custom_id);
  });
  return ids;
}

export function selectValues(components: readonly unknown[]): string[] {
  const values: string[] = [];
  walk(components, (component) => {
    if (component.type !== ComponentType.StringSelect || !Array.isArray(component.options)) return;
    for (const option of component.options as Component[]) values.push(String(option.value));
  });
  return values;
}

export function buttonLabels(components: readonly unknown[]): string[] {
  const labels: string[] = [];
  walk(components, (component) => {
    if (component.type === ComponentType.Button && typeof component.label === 'string') {
      labels.push(component.label);
    }
  });
  return labels;
}

export function said(call: Call | undefined): string {
  if (call === undefined) return '';
  const payload = call.payload;
  const embeds = Array.isArray(payload.embeds) ? (payload.embeds as Component[]) : [];
  const described = embeds.map((embed) => String(embed.description ?? '')).join('\n');
  const components = Array.isArray(payload.components) ? payload.components : [];
  return [typeof payload.content === 'string' ? payload.content : '', described, textOf(components)]
    .filter((part) => part !== '')
    .join('\n');
}
