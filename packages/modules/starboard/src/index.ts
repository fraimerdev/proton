import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  STARBOARD_SCHEMA_VERSION,
  starboardConfigSchema,
  starboardDefaultConfig,
} from './config.ts';
import type { StarboardDeps } from './deps.ts';
import { createStarboardListener } from './listener.ts';

export {
  DEFAULT_STAR_EMOJI,
  STARBOARD_SCHEMA_VERSION,
  type StarboardConfig,
  starboardConfigSchema,
  starboardDefaultConfig,
} from './config.ts';
export {
  type BoardPost,
  countStars,
  decide,
  type Eligibility,
  eligibility,
  INELIGIBLE_REASONS,
  type IneligibleReason,
  type StarboardDecision,
  type StarboardState,
  type StarCount,
} from './decide.ts';
export {
  type BindResult,
  type BoundStarboardDeps,
  bindDeps,
  describeUnbound,
  type SourceMessageRequest,
  type StarboardDeps,
} from './deps.ts';
export {
  type BoardMessage,
  type BoardMessageInput,
  buildBoardMessage,
  DESCRIPTION_MAX,
  jumpUrl,
  STAR_COLOUR,
} from './embed.ts';
export {
  createKey,
  createStarboardListener,
  MODULE_ID,
  STARBOARD_EVENT_TYPES,
} from './listener.ts';
export { DrizzleStarboardStore } from './postgres-store.ts';
export {
  type EmojiRef,
  emojiDisplay,
  emojiRestForm,
  firstImage,
  parseEmoji,
  rawStarCount,
  readReaction,
  readSourceMessage,
  type SourceAttachment,
  type SourceMessage,
  type SourceMessageExtras,
  type SourceReaction,
  type StarReaction,
  sameEmoji,
} from './source.ts';
export type { StarboardPost, StarboardStore } from './store.ts';
export {
  type NewStarboardPostRow,
  type StarboardPostRow,
  starboardPosts,
} from './table.ts';

export function createStarboardModule(
  deps: StarboardDeps = {},
): ModuleManifest<typeof starboardConfigSchema> {
  return {
    id: 'starboard',
    name: 'Starboard',
    category: 'engagement',
    configSchema: starboardConfigSchema,
    defaultConfig: starboardDefaultConfig,
    schemaVersion: STARBOARD_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],

    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.ReadMessageHistory,
      Permissions.SendMessages,
      Permissions.EmbedLinks,
    ],
    actionKinds: ['send', 'edit_message', 'delete_message'],

    listeners: [createStarboardListener(deps)],

    dashboard: {
      icon: 'star',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'boardChannelId'] },
        { id: 'threshold', title: 'Stars', fields: ['emoji', 'threshold'] },
        {
          id: 'scope',
          title: 'What can be starred',
          fields: ['sourceChannelIds', 'ignoreBots', 'selfStarAllowed', 'ignoreNsfw'],
        },
      ],
    },
  };
}

export const starboardModule: ModuleManifest<typeof starboardConfigSchema> =
  createStarboardModule();

export default starboardModule;
