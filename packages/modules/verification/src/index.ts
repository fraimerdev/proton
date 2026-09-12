import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { verificationCommands } from './commands.ts';
import {
  liftStoredConfig,
  VERIFICATION_SCHEMA_VERSION,
  verificationConfigSchema,
  verificationDefaultConfig,
  verificationFormSchema,
} from './config.ts';
import type { VerificationDeps } from './deps.ts';
import {
  createComponentListener,
  createJoinGateListener,
  createModalListener,
  createServiceListener,
} from './listeners.ts';

export {
  answerMatches,
  CAPTCHA_FALLBACK_TTL_MS,
  challengeTtlMs,
  newChallenge,
} from './challenge.ts';
export { quarantineCommand, verificationCommands, verifyCommand } from './commands.ts';
export {
  BUTTON_EMOJI_MAX,
  BUTTON_LABEL_MAX,
  CAPTCHA_ATTEMPTS_MAX,
  CAPTCHA_DELIVERIES,
  CAPTCHA_LENGTH_MAX,
  CAPTCHA_LENGTH_MIN,
  type CaptchaDelivery,
  DEFAULT_PANEL,
  PANEL_BUTTON_STYLES,
  type PanelButtonStyle,
  VERIFICATION_FAILURE_ACTIONS,
  VERIFICATION_MODES,
  VERIFICATION_SCHEMA_VERSION,
  type VerificationConfig,
  type VerificationFailureAction,
  type VerificationMode,
  type VerificationPanel,
  verificationConfigSchema,
  verificationDefaultConfig,
  verificationFormSchema,
  verificationPanelSchema,
} from './config.ts';
export {
  type BindResult,
  type BoundCaptchaDeps,
  type BoundGateDeps,
  type BoundPanelDeps,
  type BoundPressDeps,
  type BoundQuarantineDeps,
  type BoundWebsiteDeps,
  bindCaptchaDeps,
  bindGateDeps,
  bindPanelDeps,
  bindPressDeps,
  bindQuarantineDeps,
  bindWebsiteDeps,
  type CaptchaRenderer,
  describeUnbound,
  type VerificationDeps,
} from './deps.ts';
export { type FailurePlan, type FailurePlanResult, planFailure } from './failure.ts';
export {
  handleJoin,
  type JoinFacts,
  type JoinGateOutcome,
  planVerification,
  readJoin,
  runVerification,
  runVerify,
  type VerifyResult,
} from './gate.ts';
export {
  handleComponent,
  handleModal,
  type InteractionOutcome,
} from './interactions.ts';
export {
  COMPONENT_EVENT_TYPES,
  createComponentListener,
  createJoinGateListener,
  createModalListener,
  createServiceListener,
  MODAL_EVENT_TYPES,
  SERVICE_EVENT_TYPES,
  VERIFICATION_EVENT_TYPES,
} from './listeners.ts';
export {
  ANSWER_ACTION,
  type BuiltMessage,
  type BuiltTextMessage,
  buildCaptchaMessage,
  buildCaptchaModal,
  buildPanelMessage,
  buildWebsiteMessage,
  CAPTCHA_ACTION,
  CAPTCHA_MODAL_TITLE,
  CODE_FIELD,
  describeAttempts,
  REFRESH_ACTION,
  VERIFY_ACTION,
} from './panel.ts';
export {
  MESSAGE_MAX,
  MODULE_ID,
  REASON_MAX,
  runSteps,
  type StepReport,
  succeeded,
  VERIFICATION_ACTOR,
} from './perform.ts';
export { runQuarantine, runRelease } from './quarantine.ts';
export {
  checkGrantable,
  planQuarantine,
  planRelease,
  type QuarantinePlan,
  type ReleasePlan,
  type RoleCheck,
  type RoleStep,
} from './roles.ts';
export {
  handleWebPassed,
  type PanelOutcome,
  reconcilePanel,
  type WebOutcome,
} from './service.ts';
export {
  CAPTCHA_PREFIX,
  type CaptchaChallenge,
  type CaptchaStore,
  captchaChallengeSchema,
  captchaKey,
  PANEL_PREFIX,
  type PanelRecord,
  type PanelStore,
  panelKey,
  panelRecordSchema,
  QUARANTINE_PREFIX,
  type QuarantineRecord,
  type QuarantineStore,
  quarantineKey,
  quarantineRecordSchema,
  RedisCaptchaStore,
  RedisPanelStore,
  RedisQuarantineStore,
} from './store.ts';

export function createVerificationModule(
  deps: VerificationDeps = {},
): ModuleManifest<typeof verificationConfigSchema> {
  return {
    id: 'verification',
    name: 'Verification',
    category: 'security',
    configSchema: verificationConfigSchema,
    formSchema: verificationFormSchema,
    liftStoredConfig,
    defaultConfig: verificationDefaultConfig,
    schemaVersion: VERIFICATION_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    requiredPermissions: [Permissions.ManageRoles],

    // A failure action's permission is not a module-wide requirement, but every kind listed here
    // is one moduleExecutor will refuse outright, and invitePermissions() is derived from it.
    actionKinds: [
      'add_role',
      'remove_role',
      'interaction_reply',
      'interaction_followup',
      'send',
      'edit_message',
      'delete_message',
      'create_dm',
      'kick',
      'ban',
      'timeout',
    ],

    commands: verificationCommands(deps),
    listeners: [
      createJoinGateListener(deps),
      createComponentListener(deps),
      createModalListener(deps),
      createServiceListener(deps),
    ],

    // One panel, and only once it has somewhere to go. Verification also reposts it on every save
    // — this is the button for the other case, where somebody deleted the message in Discord.
    postables: (config) => [
      { id: 'panel', name: 'Verification panel', channelId: config.panelChannelId },
    ],

    dashboard: {
      icon: 'shield-check',
      sections: [
        {
          id: 'gate',
          title: 'Verification gate',
          fields: [
            'enabled',
            'mode',
            'unverifiedRoleId',
            'verifiedRoleId',
            'applyUnverifiedOnJoin',
          ],
        },
        {
          id: 'panel',
          title: 'Panel',
          fields: [
            'panelChannelId',
            'panel',
            'panelButtonLabel',
            'panelButtonEmoji',
            'panelButtonStyle',
          ],
        },
        {
          id: 'captcha',
          title: 'Captcha',
          fields: ['captchaDelivery', 'captchaLength', 'captchaAttempts', 'captchaExpiry'],
        },
        {
          id: 'failure',
          title: 'Failed verification',
          fields: ['failureAction', 'failureTimeout'],
        },
        { id: 'quarantine', title: 'Quarantine', fields: ['quarantineRoleId'] },
      ],
    },
  };
}

export const verificationModule: ModuleManifest<typeof verificationConfigSchema> =
  createVerificationModule();

export default verificationModule;
