import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { verificationCommands } from './commands.ts';
import {
  VERIFICATION_SCHEMA_VERSION,
  verificationConfigSchema,
  verificationDefaultConfig,
} from './config.ts';
import type { VerificationDeps } from './deps.ts';
import { createJoinGateListener } from './listeners.ts';

export {
  quarantineCommand,
  unquarantineCommand,
  verificationCommands,
  verifyCommand,
} from './commands.ts';
export {
  VERIFICATION_SCHEMA_VERSION,
  type VerificationConfig,
  verificationConfigSchema,
  verificationDefaultConfig,
} from './config.ts';
export {
  type BindResult,
  type BoundGateDeps,
  type BoundQuarantineDeps,
  bindGateDeps,
  bindQuarantineDeps,
  describeUnbound,
  type VerificationDeps,
} from './deps.ts';
export {
  handleJoin,
  type JoinFacts,
  type JoinGateOutcome,
  planVerification,
  readJoin,
  runVerify,
} from './gate.ts';
export { createJoinGateListener, VERIFICATION_EVENT_TYPES } from './listeners.ts';
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
  QUARANTINE_PREFIX,
  type QuarantineRecord,
  type QuarantineStore,
  quarantineKey,
  quarantineRecordSchema,
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
    defaultConfig: verificationDefaultConfig,
    schemaVersion: VERIFICATION_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    requiredPermissions: [Permissions.ManageRoles],
    actionKinds: ['add_role', 'remove_role', 'interaction_reply'],

    commands: verificationCommands(deps),
    listeners: [createJoinGateListener(deps)],

    dashboard: {
      icon: 'shield-check',
      sections: [
        {
          id: 'gate',
          title: 'Verification gate',
          fields: ['enabled', 'unverifiedRoleId', 'verifiedRoleId', 'applyUnverifiedOnJoin'],
        },
        { id: 'quarantine', title: 'Quarantine', fields: ['quarantineRoleId'] },
      ],
    },
  };
}

export const verificationModule: ModuleManifest<typeof verificationConfigSchema> =
  createVerificationModule();

export default verificationModule;
