import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { ANTIRAID_SCHEMA_VERSION, antiraidConfigSchema, antiraidDefaultConfig } from './config.ts';
import { type AntiraidDeps, createJoinListener } from './listener.ts';

export {
  ANTIRAID_SCHEMA_VERSION,
  type AntiraidConfig,
  antiraidConfigSchema,
  antiraidDefaultConfig,
  RAID_RESPONSES,
  type RaidResponse,
  readScoreSettings,
  type ScoreSettingsResult,
} from './config.ts';
export { type JoinFacts, readJoin } from './join.ts';
export {
  ANTIRAID_ACTOR,
  ANTIRAID_EVENT_TYPES,
  ANTIRAID_MODULE_ID,
  type AntiraidDeps,
  createJoinListener,
  JOIN_RATE_RULE_ID,
} from './listener.ts';
export {
  MAX_REASON_LENGTH,
  planResponse,
  RESPONSE_LABELS,
  type ResponsePlan,
  type ResponsePlanResult,
  responseKind,
  responseUnconfigured,
} from './response.ts';
export {
  type JoinSignals,
  MAX_JOIN_SCORE,
  MAX_SINGLE_SIGNAL_WEIGHT,
  MIN_ACTIONABLE_SCORE,
  type RaidScore,
  type ScoreSettings,
  SIGNAL_WEIGHTS,
  scoreJoin,
} from './score.ts';

export function createAntiraidModule(
  deps: AntiraidDeps = {},
): ModuleManifest<typeof antiraidConfigSchema> {
  return {
    id: 'antiraid',
    name: 'Anti-raid',
    category: 'security',
    configSchema: antiraidConfigSchema,
    defaultConfig: antiraidDefaultConfig,
    schemaVersion: ANTIRAID_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    requiredPermissions: [Permissions.ManageRoles, Permissions.KickMembers],
    actionKinds: ['add_role', 'kick', 'send'],

    emits: ['proton.security_tripped'],

    listeners: [createJoinListener(deps)],

    dashboard: {
      icon: 'shield-alert',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'alertChannelId'] },
        {
          id: 'detection',
          title: 'Detection',
          fields: [
            'joinWindow',
            'joinThreshold',
            'newAccountAge',
            'brandNewAccountAge',
            'scoreThreshold',
          ],
        },
        {
          id: 'response',
          title: 'Response',
          fields: ['response', 'verificationRoleId', 'quarantineRoleId'],
        },
      ],
    },
  };
}

export const antiraidModule: ModuleManifest<typeof antiraidConfigSchema> = createAntiraidModule();

export default antiraidModule;
