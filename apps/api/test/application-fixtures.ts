import {
  computeBasePermissions,
  type EventBus,
  type GuildRole,
  Permissions,
  type ProtonEvent,
  ProviderRegistry,
} from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type FormConfig,
  formSchema,
} from '@proton/module-applications/config';
import type { ApplicationRecord, FormVersionRecord } from '@proton/module-applications/store';
import { snapshotOf } from '@proton/module-applications/version';
import {
  applicationRecord,
  MemoryApplicationStore,
} from '../../../packages/modules/applications/test/memory-store.ts';
import type {
  ChannelRead,
  GuildRoster,
  MemberAccess,
  MemberAccessRead,
} from '../src/applications/member-access.ts';
import { highestPosition } from '../src/applications/member-access.ts';
import type { AuditLookup, ModulesPort } from '../src/applications/shared.ts';
import type { ModuleConfigView, ModuleState } from '../src/modules/service.ts';

export const SECRET = 'shared-secret-for-tests';

export const GUILD = '900000000000000001';
export const OTHER_GUILD = '900000000000000002';

export const OWNER = '100000000000000001';
export const ADMIN = '100000000000000002';
export const REVIEWER = '100000000000000003';
export const DECIDER = '100000000000000004';
export const SECOND = '100000000000000005';
export const OUTSIDER = '100000000000000006';
export const EVENTS_REVIEWER = '100000000000000007';
export const MODERATOR = '100000000000000008';
export const MANAGER = '100000000000000009';
export const APPLICANT = '400000000000000001';
export const OTHER_APPLICANT = '400000000000000002';
export const PROTON_BOT = '300000000000000001';

export const ADMIN_ROLE = '200000000000000001';
export const REVIEWER_ROLE = '200000000000000002';
export const DECIDER_ROLE = '200000000000000003';
export const EVENTS_ROLE = '200000000000000004';
export const MOD_ROLE = '200000000000000005';
export const LOW_ROLE = '200000000000000006';
export const HIGH_ROLE = '200000000000000007';
export const MANAGER_ROLE = '200000000000000008';
export const MANAGED_ROLE = '200000000000000009';
export const OVERRIDE_ROLE = '200000000000000010';
export const EXPORT_ROLE = '200000000000000011';
export const DELETE_ROLE = '200000000000000012';
export const PROTON_ROLE = '200000000000000013';

export const REVIEW_CHANNEL = '500000000000000001';

export const NOW = Date.UTC(2026, 8, 24, 12);
export const DAY = 24 * 60 * 60 * 1000;

export const ACCESS_WORDS =
  /forbidden|not signed in|do not administer|lack the required permission/i;

function role(id: string, position: number, permissions = 0n, managed = false): GuildRole {
  return { id, position, permissions, ...(managed ? { managed: true } : {}) };
}

export function roster(guildId = GUILD): GuildRoster {
  const roles = new Map<string, GuildRole>(
    [
      role(guildId, 0, Permissions.ViewChannel | Permissions.SendMessages),
      role(ADMIN_ROLE, 20, Permissions.Administrator),
      role(MANAGER_ROLE, 15, Permissions.ManageGuild | Permissions.ManageRoles),
      role(HIGH_ROLE, 12),
      role(MOD_ROLE, 10, Permissions.ModerateMembers),
      role(DECIDER_ROLE, 6),
      role(REVIEWER_ROLE, 5),
      role(EVENTS_ROLE, 4),
      role(OVERRIDE_ROLE, 3),
      role(EXPORT_ROLE, 3),
      role(DELETE_ROLE, 3),
      role(LOW_ROLE, 2),
      role(MANAGED_ROLE, 1, 0n, true),
      role(PROTON_ROLE, 18, Permissions.ManageRoles, true),
    ].map((entry) => [entry.id, entry]),
  );

  return {
    guildId,
    name: 'Proton Test Server',
    iconHash: 'abc123',
    ownerId: OWNER,
    everyoneRoleId: guildId,
    roles,
    botRoles: new Map([[PROTON_ROLE, PROTON_BOT]]),
  };
}

export const MEMBER_ROLES: Readonly<Record<string, string[]>> = {
  [OWNER]: [],
  [ADMIN]: [ADMIN_ROLE],
  [MANAGER]: [MANAGER_ROLE],
  [REVIEWER]: [REVIEWER_ROLE],
  [DECIDER]: [DECIDER_ROLE],
  [SECOND]: [REVIEWER_ROLE],
  [OUTSIDER]: [LOW_ROLE],
  [EVENTS_REVIEWER]: [EVENTS_ROLE],
  [MODERATOR]: [MOD_ROLE, REVIEWER_ROLE],
  [APPLICANT]: [LOW_ROLE],
  [OTHER_APPLICANT]: [],
};

export class FakeMemberAccess implements MemberAccess {
  readonly roleIds = new Map<string, string[]>(Object.entries(MEMBER_ROLES));
  readonly unavailable = new Set<string>();
  readonly absent = new Set<string>();
  readonly channels = new Map<string, ChannelRead>();
  readonly reads: string[] = [];
  rosterDown = false;
  joinedAt = NOW - 400 * DAY;

  async read(guildId: string, userId: string): Promise<MemberAccessRead> {
    this.reads.push(`${guildId}:${userId}`);
    if (this.absent.has(userId)) return { state: 'absent' };
    if (this.unavailable.has(userId) || this.rosterDown) return { state: 'unavailable' };

    const roleIds = this.roleIds.get(userId);
    if (roleIds === undefined) return { state: 'absent' };

    const guild = roster(guildId);
    return {
      state: 'member',
      actor: {
        id: userId,
        roleIds,
        permissions: computeBasePermissions({
          guildOwnerId: guild.ownerId,
          everyoneRoleId: guild.everyoneRoleId,
          memberId: userId,
          memberRoleIds: roleIds,
          roles: guild.roles,
        }),
        owner: userId === guild.ownerId,
      },
      roleIds,
      highestPosition: highestPosition(guild, roleIds),
      joinedAt: this.joinedAt,
      raw: {
        user: { id: userId, username: `user${userId.slice(-2)}`, global_name: null, avatar: null },
        nick: `Member ${userId.slice(-2)}`,
        roles: roleIds,
        joined_at: new Date(this.joinedAt).toISOString(),
      },
    };
  }

  async roles(guildId: string): Promise<GuildRoster | null> {
    return this.rosterDown ? null : roster(guildId);
  }

  async channel(channelId: string): Promise<ChannelRead> {
    return this.channels.get(channelId) ?? { state: 'missing' };
  }

  async botUserId(): Promise<string | null> {
    return PROTON_BOT;
  }
}

export function question(id: string, overrides: Record<string, unknown> = {}) {
  return { id, type: 'short', label: `Question ${id}`, ...overrides };
}

export function buildForm(overrides: Record<string, unknown> = {}): FormConfig {
  return formSchema.parse({
    id: 'mods',
    name: 'Moderator Application',
    sections: [
      {
        id: 'about',
        title: 'About you',
        questions: [
          question('why', { type: 'paragraph', label: 'Why do you want to help?' }),
          question('age', { type: 'number', label: 'How old are you?', min: 13, required: false }),
        ],
      },
    ],
    intake: { open: true, cooldownDays: 0 },
    review: { channelId: REVIEW_CHANNEL },
    ...overrides,
  });
}

export function buildConfig(overrides: Record<string, unknown> = {}): ApplicationsConfig {
  return applicationsConfigSchema.parse({
    enabled: true,
    reviewerRoleIds: [REVIEWER_ROLE, MOD_ROLE],
    deciderRoleIds: [DECIDER_ROLE],
    overrideRoleIds: [OVERRIDE_ROLE],
    exportRoleIds: [EXPORT_ROLE],
    deleteRoleIds: [DELETE_ROLE],
    forms: [
      buildForm(),
      buildForm({
        id: 'events',
        name: 'Event Application',
        review: { useDefaultTeam: false, reviewerRoleIds: [EVENTS_ROLE] },
      }),
    ],
    ...overrides,
  });
}

export interface ModulesFake extends ModulesPort {
  enabled: boolean;
  config: ApplicationsConfig;
  states: Record<string, ModuleState>;
  reads: string[];
}

export function fakeModules(config: ApplicationsConfig = buildConfig()): ModulesFake {
  const fake: ModulesFake = {
    enabled: true,
    config,
    states: {
      tickets: { on: true, config: {} },
      leveling: { on: true, config: {} },
      cases: { on: true, config: {} },
    },
    reads: [],
    async get(guildId: string, moduleId: string): Promise<ModuleConfigView> {
      fake.reads.push(`${guildId}:${moduleId}`);
      return {
        moduleId,
        enabled: fake.enabled,
        config: fake.config as unknown as Record<string, unknown>,
        schemaVersion: 1,
        migrated: false,
        tier: 'free',
        postables: [],
        simulations: [],
      };
    },
    async moduleStates(): Promise<Record<string, ModuleState>> {
      return {
        ...fake.states,
        applications: { on: fake.enabled && fake.config.enabled, config: fake.config },
      };
    },
  };
  return fake;
}

export function versionOf(form: FormConfig, guildId = GUILD, version = 1): FormVersionRecord {
  return {
    id: `version-${guildId.slice(-2)}-${form.id}-${version}`,
    guildId,
    formId: form.id,
    version,
    snapshot: snapshotOf(form),
    draftPolicy: 'keep',
    publishedBy: OWNER,
    publishedAt: NOW - 10 * DAY,
  };
}

export interface BusFake extends EventBus {
  events: ProtonEvent[];
  fail: boolean;
}

export function fakeBus(): BusFake {
  const bus: BusFake = {
    events: [],
    fail: false,
    async publish(event) {
      if (bus.fail) throw new Error('READONLY You cannot write against a replica.');
      bus.events.push(JSON.parse(JSON.stringify(event)));
    },
    subscribe() {
      throw new Error('the api never subscribes');
    },
  };
  return bus;
}

export function auditLookupOf(store: MemoryApplicationStore): AuditLookup {
  return {
    async exists(guildId, id) {
      return store.auditRows.get(id)?.guildId === guildId;
    },
  };
}

export function seedSubmitted(
  store: MemoryApplicationStore,
  overrides: Partial<ApplicationRecord> = {},
): ApplicationRecord {
  const formId = overrides.formId ?? 'mods';
  return store.seedApplication(
    applicationRecord({
      id: `app-${overrides.number ?? 1}`,
      guildId: GUILD,
      number: 1,
      formId,
      versionId: `version-${(overrides.guildId ?? GUILD).slice(-2)}-${formId}-1`,
      applicantId: APPLICANT,
      applicantName: 'Applicant',
      status: 'submitted',
      revision: 1,
      answers: [
        {
          questionId: 'why',
          sectionId: 'about',
          label: 'Why do you want to help?',
          type: 'paragraph',
          value: 'I like keeping things tidy.',
          display: 'I like keeping things tidy.',
        },
      ],
      submittedAt: NOW - DAY,
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - DAY,
      ...overrides,
    }),
  );
}

export interface Harness {
  store: MemoryApplicationStore;
  members: FakeMemberAccess;
  modules: ModulesFake;
  bus: BusFake;
  audits: NewAuditTrailEntry[];
  providers: ProviderRegistry;
  config: ApplicationsConfig;
}

export function harnessParts(config: ApplicationsConfig = buildConfig()): Harness {
  const store = new MemoryApplicationStore({ now: () => NOW });
  for (const form of config.forms) {
    store.seedVersion(versionOf(form));
    store.seedVersion(versionOf(form, OTHER_GUILD));
  }

  return {
    store,
    members: new FakeMemberAccess(),
    modules: fakeModules(config),
    bus: fakeBus(),
    audits: [],
    providers: new ProviderRegistry(),
    config,
  };
}
