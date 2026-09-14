import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { CASES_SCHEMA_VERSION, casesConfigSchema, casesDefaultConfig } from './config.ts';
import type { CaseHistoryStore } from './history.ts';
import { createCasesProviders } from './providers.ts';

export {
  CASES_SCHEMA_VERSION,
  type CasesConfig,
  casesConfigSchema,
  casesDefaultConfig,
} from './config.ts';
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
  defaultConfig: casesDefaultConfig,
  schemaVersion: CASES_SCHEMA_VERSION,

  requiredIntents: [GatewayIntentBits.Guilds],

  requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
  dashboard: {
    icon: 'gavel',
    sections: [{ id: 'general', title: 'General', fields: ['enabled'] }],
  },
};

export default casesModule;
