import {
  type ActionRequest,
  type ActionResult,
  type ApplicationLifecycleEvent,
  type EventType,
  type GuildState,
  type ModuleContext,
  Permissions,
  toRestCall,
} from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { z } from 'zod';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type FormConfig,
  formSchema,
} from '../src/config.ts';
import type { ApplicationsDeps, BoundApplicationsDeps } from '../src/deps.ts';
import { planEffects, planTicket } from '../src/effects.ts';
import type { CheckedAnswer } from '../src/questions.ts';
import { runApplicationWork } from '../src/runner.ts';
import { ACTIVE_STATUSES } from '../src/status.ts';
import type { ApplicationRecord, EffectRecord, TransitionPatch } from '../src/store.ts';
import { snapshotOf } from '../src/version.ts';
import { DAY_MS } from '../src/web.ts';
import { applicationRecord, MemoryApplicationStore } from './memory-store.ts';

export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';
export const OWNER = '100000000000000099';
export const APPLICANT = '400000000000000001';
export const REVIEWER = '100000000000000001';
export const DECIDER = '100000000000000003';

export const REVIEWER_ROLE = '410000000000000001';
export const OTHER_ROLE = '410000000000000002';
export const ADMIN_ROLE = '410000000000000003';
export const BOT_ROLE = '410000000000000009';
export const SUBMIT_ROLE = '420000000000000001';
export const ACCEPT_ROLE = '420000000000000002';
export const REMOVE_ROLE = '420000000000000003';
export const MANAGED_ROLE = '420000000000000004';
export const PING_ROLE = '420000000000000005';

export const REVIEW_CHANNEL = '500000000000000001';
export const PUBLIC_CHANNEL = '500000000000000002';
export const REVIEW_THREAD = '500000000000000003';
export const DM_CHANNEL = '800000000000000001';

export const APP_ID = '01JAPPLICATION00000000000A';
export const VERSION_ID = 'version-1';
export const DASHBOARD = 'https://prtn.xyz';
export const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

export const COMPONENTS_V2 = 32768;

export interface Call {
  request: ActionRequest;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  status: ActionResult['status'];
  result: ActionResult;
}

export interface Published {
  type: EventType;
  naturalKey: string;
  payload: Record<string, unknown>;
}

export interface Scheduled {
  jobId: string;
  runAt: number;
  naturalKey: string;
}

export function formConfig(overrides: Partial<z.input<typeof formSchema>> = {}): FormConfig {
  return formSchema.parse({
    id: 'mods',
    name: 'Moderator Application',
    sections: [
      {
        id: 'about',
        title: 'About you',
        questions: [{ id: 'why', type: 'paragraph', label: 'Why do you want to help?' }],
      },
    ],
    intake: { open: true },
    ...overrides,
  });
}

export function configWith(
  overrides: Partial<z.input<typeof applicationsConfigSchema>> = {},
  form: Partial<z.input<typeof formSchema>> = {},
): ApplicationsConfig {
  return applicationsConfigSchema.parse({
    enabled: true,
    reviewChannelId: REVIEW_CHANNEL,
    reviewerRoleIds: [REVIEWER_ROLE],
    forms: [formConfig(form)],
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
      value: 'SECRET-ANSWER keeps things tidy',
      display: 'SECRET-ANSWER keeps things tidy',
    },
  ];
}

function guildState(): GuildState {
  const role = (id: string, position: number, permissions = 0n, managed = false) =>
    [id, { id, position, permissions, ...(managed ? { managed: true } : {}) }] as const;

  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    name: 'Proton Test',
    botRoleIds: [BOT_ROLE],
    roles: new Map([
      role(GUILD, 0, Permissions.ViewChannel | Permissions.SendMessages),
      role(REVIEWER_ROLE, 2),
      role(OTHER_ROLE, 3),
      role(ADMIN_ROLE, 5, Permissions.Administrator),
      role(BOT_ROLE, 10, Permissions.ManageRoles),
      role(SUBMIT_ROLE, 1),
      role(ACCEPT_ROLE, 1),
      role(REMOVE_ROLE, 1),
      role(PING_ROLE, 1),
      role(MANAGED_ROLE, 1, 0n, true),
    ]),
    channels: new Map([
      [
        REVIEW_CHANNEL,
        {
          id: REVIEW_CHANNEL,
          parentId: null,
          type: 0,
          overwrites: [
            { id: GUILD, type: 0 as const, allow: 0n, deny: Permissions.ViewChannel },
            { id: REVIEWER_ROLE, type: 0 as const, allow: Permissions.ViewChannel, deny: 0n },
          ],
        },
      ],
      [PUBLIC_CHANNEL, { id: PUBLIC_CHANNEL, parentId: null, type: 0, overwrites: [] }],
      [REVIEW_THREAD, { id: REVIEW_THREAD, parentId: PUBLIC_CHANNEL, type: 11, overwrites: [] }],
    ]),
    updatedAt: NOW,
  };
}

type Responder = (request: ActionRequest) => ActionResult | undefined;

export class EffectsHarness {
  clock = NOW;
  readonly store = new MemoryApplicationStore({ now: () => this.clock });
  readonly calls: Call[] = [];
  readonly published: Published[] = [];
  readonly scheduled: Scheduled[] = [];
  readonly logs: { level: string; message: string }[] = [];
  readonly invalid: string[] = [];
  readonly held = new Map<string, Set<string>>();
  readonly absent = new Set<string>();
  readonly modules = new Map<string, boolean>([
    ['leveling', true],
    ['tickets', true],
  ]);

  config: ApplicationsConfig;
  state: GuildState | null = guildState();
  rolesUnknown = false;
  respond: Responder = () => undefined;

  readonly ctx: ModuleContext<ApplicationsConfig>;
  readonly deps: BoundApplicationsDeps;

  #claimed = new Set<string>();
  #messages = 0;

  constructor(config: ApplicationsConfig = configWith()) {
    this.config = config;
    const current = (): ApplicationsConfig => this.config;
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
      executor: { execute: async (request: ActionRequest) => this.#execute(request) },
      logger: { info: log('info'), warn: log('warn'), error: log('error') },
      publish: async (type: EventType, naturalKey: string, payload: unknown) => {
        this.published.push({ type, naturalKey, payload: payload as Record<string, unknown> });
      },
      schedule: async (jobId: string, runAt: Date, naturalKey: string) => {
        this.scheduled.push({ jobId, runAt: runAt.getTime(), naturalKey });
        return { scheduled: true, replaced: false };
      },
    };

    const placeholders: PlaceholderEnvironment = {
      applicationId: '300000000000000009',
      bot: async () => ({ id: '300000000000000009', supportUrl: 'https://prtn.xyz/support' }),
      server: async (guildId) => ({ id: guildId, name: 'Proton Test' }),
      user: async (userId) => ({
        id: userId,
        username: userId === APPLICANT ? 'applicant' : 'decider',
        globalName: userId === APPLICANT ? 'Applicant' : 'Decider',
        avatarHash: null,
      }),
      now: () => this.clock,
    };

    this.deps = {
      store: this.store,
      applicationId: '300000000000000009',
      dashboardUrl: DASHBOARD,
      providers: null,
      availability: {
        isEnabled: async (_guildId, moduleId) => this.modules.get(moduleId) ?? false,
      },
      guildState: { get: async () => this.state },
      placeholders,
      memberRoles: async (_guildId, userId) => {
        if (this.rolesUnknown) return null;
        if (this.absent.has(userId)) return 'absent';
        return [...(this.held.get(userId) ?? [])];
      },
      lookupMember: null,
      now: () => this.clock,
    };
  }

  #execute(request: ActionRequest): ActionResult {
    const mapped = toRestCall(request);
    if ('error' in mapped) this.invalid.push(`${request.kind}: ${mapped.error}`);

    let result: ActionResult;
    const programmed = this.respond(request);
    if (this.#claimed.has(request.idempotencyKey)) {
      result = { status: 'skipped_duplicate' };
    } else if (programmed !== undefined) {
      result = programmed;
      if (result.status === 'executed') this.#apply(request);
    } else {
      result = this.#apply(request);
    }

    if (result.status === 'executed' || result.status === 'skipped_duplicate') {
      this.#claimed.add(request.idempotencyKey);
    }

    this.calls.push({
      request,
      kind: request.kind,
      key: request.idempotencyKey,
      payload: (request.payload ?? {}) as Record<string, unknown>,
      status: result.status,
      result,
    });
    return result;
  }

  #apply(request: ActionRequest): ActionResult {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    const userId = typeof payload.userId === 'string' ? payload.userId : '';
    const roleId = typeof payload.roleId === 'string' ? payload.roleId : '';

    switch (request.kind) {
      case 'send':
        this.#messages += 1;
        return {
          status: 'executed',
          body: { id: String(1400000000000000000n + BigInt(this.#messages)) },
        };
      case 'create_dm':
        return { status: 'executed', body: { id: DM_CHANNEL } };
      case 'add_role': {
        const roles = this.held.get(userId) ?? new Set<string>();
        roles.add(roleId);
        this.held.set(userId, roles);
        return { status: 'executed' };
      }
      case 'remove_role':
        this.held.get(userId)?.delete(roleId);
        return { status: 'executed' };
      default:
        return { status: 'executed' };
    }
  }

  raw(): ApplicationsDeps {
    const bound = this.deps;
    return {
      store: bound.store,
      applicationId: bound.applicationId,
      ...(bound.dashboardUrl === null ? {} : { dashboardUrl: bound.dashboardUrl }),
      ...(bound.availability === null ? {} : { availability: bound.availability }),
      ...(bound.guildState === null ? {} : { guildState: bound.guildState }),
      ...(bound.placeholders === null ? {} : { placeholders: bound.placeholders }),
      ...(bound.memberRoles === null ? {} : { memberRoles: bound.memberRoles }),
      now: bound.now,
    };
  }

  form(): FormConfig {
    const [form] = this.config.forms;
    if (form === undefined) throw new Error('the harness config has no form');
    return form;
  }

  give(userId: string, ...roleIds: string[]): void {
    const roles = this.held.get(userId) ?? new Set<string>();
    for (const roleId of roleIds) roles.add(roleId);
    this.held.set(userId, roles);
  }

  roles(userId: string): string[] {
    return [...(this.held.get(userId) ?? [])].sort();
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  async work(applicationId?: string): Promise<void> {
    await runApplicationWork(this.ctx, this.deps, applicationId);
  }

  formNamed(formId: string | undefined): FormConfig {
    if (formId === undefined) return this.form();
    const found = this.config.forms.find((form) => form.id === formId);
    if (found === undefined) throw new Error(`the harness config has no form ${formId}`);
    return found;
  }

  async submit(options: { id?: string; formId?: string } = {}): Promise<ApplicationRecord> {
    const id = options.id ?? APP_ID;
    const form = this.formNamed(options.formId);
    const versionId = options.formId === undefined ? VERSION_ID : `${VERSION_ID}-${form.id}`;
    this.store.seedVersion({
      id: versionId,
      guildId: GUILD,
      formId: form.id,
      version: 1,
      snapshot: snapshotOf(form),
      draftPolicy: 'keep',
      publishedBy: OWNER,
      publishedAt: NOW - DAY_MS,
    });
    this.store.seedApplication(
      applicationRecord({
        id,
        guildId: GUILD,
        number: null,
        formId: form.id,
        versionId,
        applicantId: APPLICANT,
        applicantName: 'Applicant',
        status: 'draft',
        revision: 0,
        answers: null,
        submittedAt: null,
        createdAt: this.clock - DAY_MS,
        updatedAt: this.clock - DAY_MS,
      }),
    );

    const now = this.clock;
    const result = await this.store.submit({
      guildId: GUILD,
      applicationId: id,
      applicantId: APPLICANT,
      expectedRevision: 0,
      answers: answers(),
      source: 'discord',
      applicantName: 'Applicant',
      limits: { cooldownDays: 0, maxActive: 1 },
      reviewDueAt: now + 2 * DAY_MS,
      plan: (application, revision) =>
        planEffects('applications.submitted', {
          config: this.config,
          form,
          application,
          revision,
          now,
          actorId: APPLICANT,
        }),
      lifecycle: {
        guildId: GUILD,
        applicationId: id,
        formId: form.id,
        formName: form.name,
        versionId,
        applicantId: APPLICANT,
        actorId: APPLICANT,
      },
      now,
    });
    if (result.status !== 'submitted') throw new Error(`submit refused: ${result.message}`);
    return result.application;
  }

  async move(input: {
    action: 'accept' | 'reject' | 'waitlist' | 'reopen' | 'request_info' | 'claim';
    patch: TransitionPatch;
    lifecycle: ApplicationLifecycleEvent | null;
    from?: readonly ApplicationRecord['status'][];
    actorId?: string;
    thread?: { kind: 'info_request'; body: string };
    applicationId?: string;
  }): Promise<ApplicationRecord> {
    const id = input.applicationId ?? APP_ID;
    const current = await this.store.get(GUILD, id);
    const form =
      this.config.forms.find((candidate) => candidate.id === current?.formId) ?? this.form();
    const now = this.clock;
    const actorId = input.actorId ?? DECIDER;
    const lifecycle = input.lifecycle;

    const result = await this.store.transition({
      guildId: GUILD,
      applicationId: id,
      action: input.action,
      actor: { id: actorId, source: 'discord' },
      expect: { statuses: input.from ?? ACTIVE_STATUSES },
      patch: input.patch,
      ...(input.thread === undefined ? {} : { thread: input.thread }),
      event: {
        kind: input.action,
        ...(lifecycle === null ? {} : { lifecycle }),
      },
      plan: (application, revision) =>
        planEffects(lifecycle ?? 'card_only', {
          config: this.config,
          form,
          application,
          revision,
          now,
          actorId,
        }),
      now,
    });
    if (result.status !== 'done') throw new Error(`the ${input.action} transition went stale`);
    return result.application;
  }

  accept(
    reason: string | null = 'Welcome aboard.',
    applicationId?: string,
  ): Promise<ApplicationRecord> {
    return this.move({
      action: 'accept',
      lifecycle: 'applications.accepted',
      patch: {
        status: 'accepted',
        decidedAt: this.clock,
        decidedBy: DECIDER,
        decisionReason: reason,
        contentPurgeAt: this.clock + 30 * DAY_MS,
      },
      ...(applicationId === undefined ? {} : { applicationId }),
    });
  }

  reject(applicationId?: string): Promise<ApplicationRecord> {
    return this.move({
      action: 'reject',
      lifecycle: 'applications.rejected',
      patch: {
        status: 'rejected',
        decidedAt: this.clock,
        decidedBy: DECIDER,
        decisionReason: null,
        contentPurgeAt: this.clock + 30 * DAY_MS,
      },
      ...(applicationId === undefined ? {} : { applicationId }),
    });
  }

  reopen(): Promise<ApplicationRecord> {
    return this.move({
      action: 'reopen',
      lifecycle: 'applications.reopened',
      from: ['accepted', 'rejected'],
      patch: { status: 'submitted', contentPurgeAt: null, reopenedCount: 1 },
    });
  }

  claim(): Promise<ApplicationRecord> {
    return this.move({
      action: 'claim',
      lifecycle: 'applications.review_started',
      actorId: REVIEWER,
      patch: { status: 'in_review', assigneeId: REVIEWER, assignedAt: this.clock },
    });
  }

  requestInfo(body = 'Which timezone are you in?'): Promise<ApplicationRecord> {
    return this.move({
      action: 'request_info',
      lifecycle: 'applications.information_requested',
      actorId: REVIEWER,
      thread: { kind: 'info_request', body },
      patch: {
        status: 'needs_info',
        infoRequestedAt: this.clock,
        infoDueAt: this.clock + 14 * DAY_MS,
      },
    });
  }

  async openTicket(): Promise<void> {
    const form = this.form();
    const now = this.clock;
    const result = await this.store.transition({
      guildId: GUILD,
      applicationId: APP_ID,
      action: 'open_ticket',
      actor: { id: REVIEWER, source: 'discord' },
      expect: { statuses: ACTIVE_STATUSES },
      patch: {},
      event: { kind: 'ticket_requested' },
      plan: (application, revision) =>
        planTicket({ config: this.config, form, application, revision, now, actorId: REVIEWER }),
      now,
    });
    if (result.status !== 'done') throw new Error('the open_ticket transition went stale');
  }

  effects(applicationId = APP_ID): EffectRecord[] {
    return this.store.effectsOf(applicationId);
  }

  effect(key: string, applicationId = APP_ID): EffectRecord {
    const found = this.effects(applicationId).find((effect) => effect.key === key);
    if (found === undefined) throw new Error(`no effect under ${key}`);
    return found;
  }

  byKind(kind: string): EffectRecord[] {
    return this.effects().filter((effect) => effect.kind === kind);
  }

  callsOf(kind: string): Call[] {
    return this.calls.filter((call) => call.kind === kind);
  }

  publishedOf(type: EventType): Published[] {
    return this.published.filter((entry) => entry.type === type);
  }

  async application(): Promise<ApplicationRecord> {
    const found = await this.store.get(GUILD, APP_ID);
    if (found === null) throw new Error('the harness application is gone');
    return found;
  }
}

export function texts(components: unknown): string {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.content === 'string') out.push(record.content);
    visit(record.components);
  };
  visit(components);
  return out.join('\n');
}

export function failure(code: string, humanReason: string, discordCode?: number): ActionResult {
  return {
    status:
      code.startsWith('discord_') || code === 'transport_failure'
        ? 'failed_api'
        : 'failed_precheck',
    failure: { code, humanReason, ...(discordCode === undefined ? {} : { discordCode }) },
  };
}
