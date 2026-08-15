import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  CASES_SCHEMA_VERSION,
  casesConfigSchema,
  casesDefaultConfig,
  casesFormSchema,
} from './config.ts';
import { casesPresetRules } from './escalation.ts';

export {
  CASES_SCHEMA_VERSION,
  type CasesConfig,
  casesConfigSchema,
  casesDefaultConfig,
  casesFormSchema,
  ESCALATION_ACTIONS,
  type EscalationAction,
  type EscalationRung,
  escalationLadderSchema,
  escalationRungSchema,
} from './config.ts';
export { casesPresetRules, escalationRuleId, escalationRules } from './escalation.ts';

export const casesModule: ModuleManifest<typeof casesConfigSchema> = {
  id: 'cases',
  name: 'Cases',
  category: 'moderation',
  configSchema: casesConfigSchema,

  formSchema: casesFormSchema,
  defaultConfig: casesDefaultConfig,
  schemaVersion: CASES_SCHEMA_VERSION,

  requiredIntents: [GatewayIntentBits.Guilds],

  requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
  rules: casesPresetRules,
  migrations: [],
  dashboard: {
    icon: 'gavel',
    sections: [
      { id: 'general', title: 'General', fields: ['enabled', 'historyLimit'] },
      {
        id: 'escalation',
        title: 'Warn escalation',

        fields: ['escalationWindow', 'escalationLadder'],
      },
    ],
  },
};

export default casesModule;
