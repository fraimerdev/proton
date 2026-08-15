import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { rolemenuCommands } from './commands.ts';
import {
  ROLEMENU_SCHEMA_VERSION,
  rolemenuConfigSchema,
  rolemenuDefaultConfig,
  rolemenuFormSchema,
} from './config.ts';
import type { RolemenuDeps } from './deps.ts';
import { createComponentListener, createReactionListener } from './listeners.ts';

export { rolemenuCommand, rolemenuCommands } from './commands.ts';
export {
  BINDING_KEY_MAX,
  BINDING_LABEL_MAX,
  findMenu,
  MAX_BINDINGS_PER_MENU,
  MAX_MENUS,
  MENU_ID_MAX,
  ROLEMENU_KINDS,
  ROLEMENU_MODES,
  ROLEMENU_SCHEMA_VERSION,
  type RolemenuBinding,
  type RolemenuConfig,
  type RolemenuKind,
  type RolemenuMenu,
  type RolemenuMode,
  rolemenuBindingSchema,
  rolemenuConfigSchema,
  rolemenuDefaultConfig,
  rolemenuFormSchema,
  rolemenuMenuSchema,
  rolemenuMenusSchema,
} from './config.ts';
export {
  CUSTOM_ID_PREFIX,
  CUSTOM_ID_SEPARATOR,
  encodeCustomId,
  hasRolemenuPrefix,
  parseCustomId,
  type RolemenuCustomId,
  SELECT_BINDING_KEY,
} from './custom-id.ts';
export {
  type BindResult,
  type BoundComponentDeps,
  type BoundReactionDeps,
  bindComponentDeps,
  bindReactionDeps,
  describeUnbound,
  type RolemenuDeps,
} from './deps.ts';
export {
  type ComponentFacts,
  type ComponentOutcome,
  handleComponent,
  readComponent,
} from './interactions.ts';
export {
  COMPONENT_EVENT_TYPES,
  createComponentListener,
  createReactionListener,
  REACTION_EVENT_TYPES,
  ROLEMENU_EVENT_TYPES,
} from './listeners.ts';
export {
  buildButtonRows,
  buildComponents,
  buildSelectRow,
  type MessageComponent,
} from './message.ts';
export {
  describeReport,
  MESSAGE_MAX,
  MODULE_ID,
  REASON_MAX,
  type RoleChangeReport,
  runRoleChanges,
  succeeded,
} from './perform.ts';
export {
  handleReaction,
  type ReactionFacts,
  type ReactionOutcome,
  readReaction,
} from './reactions.ts';
export {
  type ResolveInput,
  ROLEMENU_INTENTS,
  type RoleChanges,
  type RolemenuIntent,
  resolveRoleChanges,
} from './resolve.ts';

export function createRolemenuModule(
  deps: RolemenuDeps = {},
): ModuleManifest<typeof rolemenuConfigSchema> {
  return {
    id: 'rolemenu',
    name: 'Role menus',
    category: 'engagement',
    configSchema: rolemenuConfigSchema,

    formSchema: rolemenuFormSchema,
    defaultConfig: rolemenuDefaultConfig,
    schemaVersion: ROLEMENU_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],

    requiredPermissions: [Permissions.ManageRoles],

    commands: rolemenuCommands,
    listeners: [createReactionListener(deps), createComponentListener(deps)],

    migrations: [],

    dashboard: {
      icon: 'list-checks',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        {
          id: 'menus',
          title: 'Menus',

          fields: ['menus'],
        },
      ],
    },
  };
}

export const rolemenuModule: ModuleManifest<typeof rolemenuConfigSchema> = createRolemenuModule();

export default rolemenuModule;
