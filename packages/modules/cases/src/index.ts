import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  CASES_SCHEMA_VERSION,
  casesConfigSchema,
  casesDefaultConfig,
  casesFormSchema,
} from './config.ts';
import { casesPresetRules, escalationRules } from './escalation.ts';
import type { CaseHistoryStore } from './history.ts';
import { createCasesProviders } from './providers.ts';

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
export {
  CASE_TYPES,
  type CaseCountQuery,
  type CaseHistoryStore,
  type CaseType,
} from './history.ts';
export { CASES_MODULE_ID, createCasesProviders } from './providers.ts';

export interface CasesDeps {
  // Unbound means cases registers no providers: a requirement that can never be judged should not
  // appear in the picker at all.
  history?: CaseHistoryStore;
}

export function createCasesModule(deps: CasesDeps = {}): ModuleManifest<typeof casesConfigSchema> {
  return {
    ...casesModule,
    ...(deps.history ? { providers: createCasesProviders(deps.history) } : {}),
  };
}

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
  compileRules: (config) => escalationRules(config),
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
