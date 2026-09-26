import { type EventType, type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { applyCommand } from './commands/apply.ts';
import { applicationsCommand } from './commands/review.ts';
import {
  APPLICATIONS_SCHEMA_VERSION,
  applicationsConfigSchema,
  applicationsDefaultConfig,
  applicationsFormSchema,
  grantedRoles,
} from './config.ts';
import { MODULE_ID } from './constants.ts';
import type { ApplicationsDeps } from './deps.ts';
import {
  createApplicationsAutocompleteListener,
  createApplicationsInteractionListener,
} from './interactions.ts';
import { APPLICATION_SCHEDULES, createScheduledHandlers, PURGE_CRON, PURGE_JOB } from './jobs.ts';
import { createApplicationsListeners } from './listeners.ts';
import { applicationsTemplates } from './placeholders.ts';
import { applicationsSimulations } from './simulation.ts';
import { SWEEP_JOB } from './store.ts';

export * from './authorize.ts';
export { applyCommand } from './commands/apply.ts';
export { applicationsCommand } from './commands/review.ts';
export * from './config.ts';
export * from './constants.ts';
export {
  type ApplicationsDeps,
  type BindResult,
  type BoundApplicationsDeps,
  bindApplicationsDeps,
  describeUnbound,
  type MemberLookup,
  type MemberRolesLookup,
} from './deps.ts';
export * from './effects.ts';
export * from './eligibility.ts';
export * from './intake.ts';
export {
  createApplicationsAutocompleteListener,
  createApplicationsInteractionListener,
} from './interactions.ts';
export {
  APPLICATION_SCHEDULES,
  type ApplicationSchedule,
  createScheduledHandlers,
  PURGE_BATCH,
  PURGE_CRON,
  PURGE_JOB,
  PURGE_ROUNDS,
  purgeApplications,
  runSweep,
  SWEEP_BATCH,
} from './jobs.ts';
export { createApplicationsListeners } from './listeners.ts';
export {
  type ApplicantDm,
  type ApplicantDmFacts,
  DM_UNCONFIRMED,
  DMS_CLOSED,
  type DmBody,
  type DmDelivery,
  deliverApplicantDm,
  NO_MUTUAL_SERVER,
  renderApplicantDm,
} from './notify.ts';
export { buildPanel, sendPanel } from './panel.ts';
export * from './placeholders.ts';
export { DrizzleApplicationStore } from './postgres-store.ts';
export * from './questions.ts';
export {
  armSweep,
  backoffAt,
  publishActionFailed,
  refreshCard,
  requestWork,
  runApplicationWork,
  runEffects,
  WORK_BATCH,
} from './runner.ts';
export { applicationsSimulations } from './simulation.ts';
export * from './status.ts';
export type {
  Actor,
  ApplicantSource,
  ApplicationDetailRecord,
  ApplicationRecord,
  ApplicationStore,
  AuditInput,
  AuditSource,
  DeleteApplicantInput,
  DeleteApplicationInput,
  DeleteApplicationResult,
  DraftPolicy,
  DueWork,
  EffectClaim,
  EffectOutcome,
  EffectRecord,
  EventRecord,
  ExportRowsQuery,
  FormCounts,
  FormVersionRecord,
  ListQuery,
  ListResult,
  NoteRecord,
  PlanEffects,
  PublishInput,
  PublishOutcome,
  RequestAnswer,
  RequestedEffect,
  SaveDraftInput,
  SaveDraftResult,
  Source,
  StartDraftInput,
  SubmitInput,
  SubmitLimits,
  SubmitRefusalCode,
  SubmitResult,
  ThreadKind,
  ThreadRecord,
  TransitionExpect,
  TransitionInput,
  TransitionPatch,
  TransitionResult,
  VoteChoice,
  VoteRecord,
  VoteTally,
} from './store.ts';
export { SWEEP_JOB, WAKE_KEY, wakeSlot } from './store.ts';
export * from './templates.ts';
export * from './version.ts';

export const APPLICATION_EVENTS_EMITTED: EventType[] = [
  'applications.submitted',
  'applications.review_started',
  'applications.information_requested',
  'applications.information_provided',
  'applications.waitlisted',
  'applications.accepted',
  'applications.rejected',
  'applications.withdrawn',
  'applications.reopened',
  'applications.expired',
  'applications.action_failed',
  'applications.work_requested',
  'xp.grant_requested',
  'tickets.open_requested',
];

export function createApplicationsModule(
  deps: ApplicationsDeps = {},
): ModuleManifest<typeof applicationsConfigSchema> {
  return {
    id: MODULE_ID,
    name: 'Applications',
    category: 'utility',
    configSchema: applicationsConfigSchema,
    formSchema: applicationsFormSchema,
    defaultConfig: applicationsDefaultConfig,
    schemaVersion: APPLICATIONS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],

    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'interaction_edit_original',
      'send',
      'edit_message',
      'delete_message',
      'create_dm',
      'add_role',
      'remove_role',
    ],

    emits: [...APPLICATION_EVENTS_EMITTED],

    interactionConcurrency: 8,

    configLimits: [
      { key: 'applicationForms', path: 'forms' },
      { key: 'applicationPanels', path: 'panels' },
    ],

    postables: (config) =>
      config.panels.map((panel) => ({
        id: panel.id,
        name: panel.name,
        ...(panel.channelId === undefined ? {} : { channelId: panel.channelId }),
      })),

    grantedRoles: (config) => grantedRoles(config),

    templates: applicationsTemplates,
    simulations: applicationsSimulations,

    commands: [applyCommand(deps), applicationsCommand(deps)],
    listeners: [
      createApplicationsInteractionListener(deps),
      createApplicationsAutocompleteListener(deps),
      ...createApplicationsListeners(deps),
    ],

    schedules: [...APPLICATION_SCHEDULES],
    scheduledHandlers: createScheduledHandlers(deps),
    scheduledWhileDisabled: [SWEEP_JOB],
    jobs: [{ id: PURGE_JOB, cron: PURGE_CRON }],

    dashboard: {
      icon: 'identification-card',
      sections: [
        {
          id: 'review',
          title: 'Review',
          fields: ['enabled', 'reviewChannelId', 'reviewerRoleIds'],
        },
      ],
    },
  };
}

export const applicationsModule: ModuleManifest<typeof applicationsConfigSchema> =
  createApplicationsModule();

export default applicationsModule;
