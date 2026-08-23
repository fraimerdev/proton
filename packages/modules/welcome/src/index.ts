import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  WELCOME_SCHEMA_VERSION,
  welcomeConfigSchema,
  welcomeDefaultConfig,
  welcomeFormSchema,
} from './config.ts';
import { createGreetingListener, type WelcomeDeps } from './listeners.ts';

export {
  DEFAULT_GOODBYE_GREETING,
  DEFAULT_GOODBYE_MESSAGE,
  DEFAULT_WELCOME_GREETING,
  DEFAULT_WELCOME_MESSAGE,
  type GreetingFacts,
  type GreetingMessage,
  greetingMessageSchema,
  isSilentGreeting,
  liftLegacyGreeting,
  renderGreeting,
  WELCOME_PLACEHOLDERS,
  WELCOME_SCHEMA_VERSION,
  type WelcomeConfig,
  type WelcomePlaceholder,
  welcomeConfigSchema,
  welcomeDefaultConfig,
  welcomeFormSchema,
} from './config.ts';
export {
  createGreetingListener,
  type GreetingTarget,
  readGreetingTarget,
  WELCOME_ACTOR,
  WELCOME_EVENT_TYPES,
  WELCOME_MODULE_ID,
  type WelcomeDeps,
} from './listeners.ts';

export function createWelcomeModule(
  deps: WelcomeDeps = {},
): ModuleManifest<typeof welcomeConfigSchema> {
  return {
    id: 'welcome',
    name: 'Welcome & goodbye',
    category: 'engagement',
    configSchema: welcomeConfigSchema,
    formSchema: welcomeFormSchema,
    defaultConfig: welcomeDefaultConfig,
    schemaVersion: WELCOME_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: ['send'],

    listeners: [createGreetingListener(deps)],

    dashboard: {
      icon: 'hand-wave',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'welcome', title: 'Welcome', fields: ['welcomeChannelId'] },
        { id: 'goodbye', title: 'Goodbye', fields: ['goodbyeChannelId'] },
        {
          id: 'card',
          title: 'Card',
          fields: ['card', 'preset', 'cardAccent', 'cardBackgroundUrl', 'cardShowMemberCount'],
        },
      ],
    },
  };
}

export const welcomeModule: ModuleManifest<typeof welcomeConfigSchema> = createWelcomeModule();

export default welcomeModule;
