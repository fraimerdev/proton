import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { messagesCommands } from './commands.ts';
import {
  liftSavedEmbeds,
  MESSAGES_SCHEMA_VERSION,
  messagesConfigSchema,
  messagesDefaultConfig,
  messagesFormSchema,
} from './config.ts';
import type { MessagesDeps } from './deps.ts';
import { createMessagesAutocompleteListener, createMessagesModalListener } from './interactions.ts';
import { createMessagesComponentListener } from './interactions-component.ts';
import { createMessagesScheduleListener } from './schedule-listener.ts';
import { POST_JOB, runScheduledPost } from './scheduled-post.ts';

export {
  describeList,
  describeUnknown,
  messageCommand,
  messagesCommands,
} from './commands.ts';
export {
  buildComposerModal,
  COLOUR_FIELD,
  COMPOSER_TITLE,
  type ComposedEmbedResult,
  type ComposerModalResult,
  DESCRIPTION_FIELD,
  IMAGE_FIELD,
  readComposedEmbed,
  SEND_ACTION,
  TITLE_FIELD,
} from './compose.ts';
export {
  COMPONENT_NAME_MAX,
  componentKeys,
  EMBED_AUTHOR_NAME_MAX,
  EMBED_COLOR_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
  EMBED_URL_MAX,
  type EmbedContent,
  type EmbedField,
  embedContentSchema,
  embedFieldSchema,
  findTemplate,
  liftSavedEmbeds,
  MAX_SAVED_COMPONENTS,
  MAX_TEMPLATES,
  MESSAGES_SCHEMA_VERSION,
  type MessagesConfig,
  MODULE_ID,
  messagesConfigSchema,
  messagesDefaultConfig,
  messagesFormSchema,
  normaliseTemplateName,
  renderNames,
  type SavedComponent,
  savedComponentSchema,
  savedComponentsSchema,
  suggestTemplateNames,
  TEMPLATE_LIST_SHOWN,
  TEMPLATE_NAME_MAX,
  TEMPLATE_NAMES_SHOWN,
  type Template,
  templateContentSchema,
  templatesSchema,
  withFreshKeys,
} from './config.ts';
export {
  type BindResult,
  type BoundFollowUpDeps,
  bindFollowUp,
  describeUnbound,
  type MessagesDeps,
} from './deps.ts';
export {
  type BuildEmbedOptions,
  type BuildEmbedResult,
  buildEmbed,
  type ColourResult,
  DEFAULT_SUBJECT,
  type DiscordEmbed,
  type DiscordEmbedField,
  embedLength,
  type LinkResult,
  parseEmbedColour,
  parseEmbedLink,
} from './embed.ts';
export {
  type AutocompleteOutcome,
  createMessagesAutocompleteListener,
  createMessagesModalListener,
  handleAutocomplete,
  handleModalSubmit,
  MESSAGES_AUTOCOMPLETE_EVENT_TYPES,
  MESSAGES_MODAL_EVENT_TYPES,
  type ModalOutcome,
} from './interactions.ts';
export {
  type ComponentOutcome,
  createMessagesComponentListener,
  handleComponentPress,
  MESSAGES_COMPONENT_EVENT_TYPES,
} from './interactions-component.ts';
export {
  acknowledge,
  type ChangeRolesInput,
  changeRoles,
  describeReport,
  type MessagesContext,
  type PostEmbedInput,
  type PostMessageInput,
  postEmbed,
  postMessage,
  REASON_MAX,
  type RoleChangeReport,
  respondTo,
  succeeded,
} from './perform.ts';
export {
  type CancelIntent,
  type CancelReason,
  followingRun,
  type NextRun,
  nextRun,
  type ReconcilePlan,
  reconcile,
  type ScheduleIntent,
  scheduledTemplates,
} from './schedule.ts';
export {
  createMessagesScheduleListener,
  MESSAGES_RECONCILE_EVENT_TYPES,
  type ReconcileOutcome,
  reconcileSchedules,
} from './schedule-listener.ts';
export {
  POST_JOB,
  type PostData,
  type PostOutcome,
  postDataSchema,
  postKey,
  runScheduledPost,
  SCHEDULED_ACTOR,
} from './scheduled-post.ts';

export function createMessagesModule(
  deps: MessagesDeps = {},
): ModuleManifest<typeof messagesConfigSchema> {
  return {
    id: 'messages',
    name: 'Messages',
    category: 'utility',
    configSchema: messagesConfigSchema,
    formSchema: messagesFormSchema,
    defaultConfig: messagesDefaultConfig,
    schemaVersion: MESSAGES_SCHEMA_VERSION,
    liftStoredConfig: liftSavedEmbeds,

    requiredIntents: [GatewayIntentBits.Guilds],

    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.EmbedLinks,
    ],
    // Manage Roles is not in requiredPermissions: a server that never gives a button a role action
    // must not have the whole module marked broken for a permission it does not need.
    actionKinds: ['interaction_reply', 'interaction_followup', 'send', 'add_role', 'remove_role'],

    configLimits: [{ key: 'savedTemplates', path: 'templates' }],

    commands: messagesCommands(deps),
    listeners: [
      createMessagesModalListener(deps),
      createMessagesAutocompleteListener(),
      createMessagesComponentListener(deps),
      createMessagesScheduleListener(),
    ],

    schedules: [POST_JOB],
    scheduledHandlers: {
      [POST_JOB]: async (data, ctx) => {
        await runScheduledPost(data, ctx);
      },
    },

    dashboard: {
      icon: 'message-square',
      sections: [{ id: 'general', title: 'General', fields: ['enabled'] }],
    },
  };
}

export const messagesModule: ModuleManifest<typeof messagesConfigSchema> = createMessagesModule();

export default messagesModule;
