import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  APPEALS_SCHEMA_VERSION,
  appealsConfigSchema,
  appealsDefaultConfig,
  appealsFormSchema,
} from './config.ts';
import type { AppealsDeps } from './deps.ts';
import { createAppealsInteractionListener } from './interactions.ts';
import { createAppealsListener } from './listeners.ts';

export {
  mayReview,
  REVIEWER_PERMISSIONS,
  type ReviewerCheck,
  readPermissions,
  readRoleIds,
} from './authorize.ts';
export {
  ANSWER_MAX,
  APPEALS_ACTOR,
  APPEALS_SCHEMA_VERSION,
  APPROVE_ACTIONS,
  type AppealPanel,
  type AppealQuestion,
  type AppealsConfig,
  type ApproveAction,
  appealPanelSchema,
  appealPanelsSchema,
  appealQuestionSchema,
  appealsConfigSchema,
  appealsDefaultConfig,
  appealsFormSchema,
  livePanels,
  MODULE_ID,
  PANEL_ID_MAX,
  PANELS_CEILING,
  panelFor,
  QUESTIONS_MAX,
  reviewChannelFor,
  reviewerRolesFor,
} from './config.ts';
export { type ApplyOutcome, applyDecision, stampCard } from './decision.ts';
export {
  type AppealsDeps,
  type BindResult,
  type BoundAppealsDeps,
  bindAppealsDeps,
  describeUnbound,
} from './deps.ts';
export {
  APPEALS_INTERACTION_EVENT_TYPES,
  createAppealsInteractionListener,
  handleReviewPress,
  type ReviewOutcome,
} from './interactions.ts';
export {
  APPEALS_EVENT_TYPES,
  createAppealsListener,
  type PostOutcome,
  postReviewCard,
} from './listeners.ts';
export {
  DM_ATTEMPTS_MAX,
  decisionMessage,
  type NotifyOutcome,
  tellAppellant,
} from './notify.ts';
export { DrizzleAppealStore } from './postgres-store.ts';
export {
  APPEAL_APPROVED,
  APPEAL_DENIED,
  APPEAL_OPEN,
  APPROVE_ACTION,
  buildReviewCard,
  DENY_ACTION,
  type ReviewCard,
} from './review.ts';
export type {
  AppealRecord,
  AppealStore,
  DecideInput,
  FileAppealInput,
} from './store.ts';
export { type AppealAnswerRow, type AppealRow, appealAnswers, appeals } from './table.ts';
export {
  type AnswerCheck,
  APPEAL_STATES,
  type AppealAnswers,
  type AppealState,
  type AppealView,
  type AppealViewInput,
  appealAnswersSchema,
  appealView,
  type CheckedAnswer,
  checkAnswers,
  DAY_MS,
  type FiledAppeal,
} from './web.ts';

export function createAppealsModule(
  deps: AppealsDeps = {},
): ModuleManifest<typeof appealsConfigSchema> {
  return {
    id: 'appeals',
    name: 'Appeals',
    category: 'moderation',
    configSchema: appealsConfigSchema,
    formSchema: appealsFormSchema,
    defaultConfig: appealsDefaultConfig,
    schemaVersion: APPEALS_SCHEMA_VERSION,

    // An appeal arrives over the web and is decided in a channel. Nothing here reads a message or
    // watches a member, so the one unprivileged intent is all it needs.
    requiredIntents: [GatewayIntentBits.Guilds],

    // What accepting an appeal usually means. A form set to untimeout or to do nothing needs less,
    // but reporting the module dead per form is worse than naming the common case.
    requiredPermissions: [Permissions.BanMembers],

    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'send',
      'edit_message',
      'unban',
      'untimeout',
      'create_dm',
    ],

    emits: ['appeals.decided'],

    configLimits: [{ key: 'appealPanels', path: 'panels' }],

    listeners: [createAppealsListener(deps), createAppealsInteractionListener(deps)],

    dashboard: {
      icon: 'scales',
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

export const appealsModule: ModuleManifest<typeof appealsConfigSchema> = createAppealsModule();

export default appealsModule;
