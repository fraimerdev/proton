import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { WELCOME_SCHEMA_VERSION, welcomeConfigSchema, welcomeDefaultConfig } from './config.ts';
import { createGreetingListener, type WelcomeDeps } from './listeners.ts';

export {
  DEFAULT_GOODBYE_MESSAGE,
  DEFAULT_WELCOME_MESSAGE,
  type GreetingFacts,
  renderGreeting,
  WELCOME_PLACEHOLDERS,
  WELCOME_SCHEMA_VERSION,
  type WelcomeConfig,
  type WelcomePlaceholder,
  welcomeConfigSchema,
  welcomeDefaultConfig,
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

/**
 * Welcome and goodbye greetings, with optional cards (PLAN.md §8, Phase 3).
 *
 * A factory rather than a constant so the card renderer can be injected —
 * without that, every test would rasterise a real PNG and fetch a real avatar
 * from Discord's CDN, which I11 forbids.
 *
 * The one behaviour worth stating at the manifest level: **a card failure never
 * costs the message**. Rendering is decoration, greeting is the feature, and a
 * font fault that no retry fixes must not silence every welcome in every guild.
 * See `renderGreetingCard`.
 */
export function createWelcomeModule(
  deps: WelcomeDeps = {},
): ModuleManifest<typeof welcomeConfigSchema> {
  return {
    id: 'welcome',
    name: 'Welcome & goodbye',
    category: 'engagement',
    configSchema: welcomeConfigSchema,
    defaultConfig: welcomeDefaultConfig,
    schemaVersion: WELCOME_SCHEMA_VERSION,

    /**
     * GUILD_MEMBERS is privileged and the module is nothing without it: neither
     * GUILD_MEMBER_ADD nor GUILD_MEMBER_REMOVE is dispatched without it, so every
     * greeting would silently never happen. Declaring it means the registry
     * disables the module with the intent named and the portal toggle to flip
     * (§7), instead of an admin concluding the bot is broken.
     */
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    /**
     * Sending is the whole feature, so both are a hard gate — unlike `cases`,
     * which keeps ban rights out of its requirements because it has value
     * without them. A welcome module that cannot post has none.
     *
     * ATTACH_FILES is deliberately absent even though cards are attachments:
     * cards are off by default and optional, and gating the text greeting on a
     * permission only the optional half needs would disable the module for every
     * guild that never turned cards on. A missing ATTACH_FILES surfaces as
     * Discord's own 403 through the executor instead, which names it.
     */
    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],

    listeners: [createGreetingListener(deps)],
    migrations: [],

    dashboard: {
      icon: 'hand-wave',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'welcome', title: 'Welcome', fields: ['welcomeChannelId', 'welcomeMessage'] },
        { id: 'goodbye', title: 'Goodbye', fields: ['goodbyeChannelId', 'goodbyeMessage'] },
        { id: 'card', title: 'Card', fields: ['card', 'preset'] },
      ],
    },
  };
}

/** The module as the registry and dashboard see it, with the default renderer. */
export const welcomeModule: ModuleManifest<typeof welcomeConfigSchema> = createWelcomeModule();

export default welcomeModule;
