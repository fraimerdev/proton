import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createTagsAutocompleteListener } from './autocomplete.ts';
import { tagsCommands } from './commands.ts';
import { TAGS_SCHEMA_VERSION, tagsConfigSchema, tagsDefaultConfig } from './config.ts';
import type { TagsDeps } from './deps.ts';

export {
  type AutocompleteOutcome,
  createTagsAutocompleteListener,
  handleAutocomplete,
  normalisePrefix,
  TAGS_EVENT_TYPES,
} from './autocomplete.ts';
export { renderList, tagCommand, tagsCommand, tagsCommands } from './commands.ts';
export {
  MODULE_ID,
  normaliseTagName,
  TAG_CONTENT_MAX,
  TAG_LIST_PAGE_SIZE,
  TAG_NAME_MAX,
  TAGS_SCHEMA_VERSION,
  type TagNameResult,
  type TagsConfig,
  tagsConfigSchema,
  tagsDefaultConfig,
} from './config.ts';
export { bindStore, describeUnbound, type StoreBinding, type TagsDeps } from './deps.ts';
export { MENTIONS_OFF, type ReplyOptions, reply } from './perform.ts';
export { DrizzleTagStore } from './postgres-store.ts';
export {
  TAG_PAGE_SIZE_DEFAULT,
  TAG_PAGE_SIZE_MAX,
  TAG_SORT_DIRECTIONS,
  TAG_SORT_FIELDS,
  type TagQuery,
  type TagQueryInput,
  type TagSearchResult,
  type TagSortDirection,
  type TagSortField,
  type TagSummary,
  tagQuerySchema,
  toSummary,
} from './query.ts';
export type {
  CreateTagInput,
  ListTagsQuery,
  ListTagsResult,
  Tag,
  TagStore,
} from './store.ts';
export { type NewTagRow, type TagRow, tags } from './table.ts';

export function createTagsModule(deps: TagsDeps = {}): ModuleManifest<typeof tagsConfigSchema> {
  return {
    id: 'tags',
    name: 'Tags',
    category: 'utility',
    configSchema: tagsConfigSchema,
    defaultConfig: tagsDefaultConfig,
    schemaVersion: TAGS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: ['interaction_reply'],

    commands: tagsCommands(deps),
    listeners: [createTagsAutocompleteListener(deps)],

    dashboard: {
      icon: 'tag',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'posting', title: 'How tags are posted', fields: ['ephemeral', 'allowMentions'] },
      ],
    },
  };
}

export const tagsModule: ModuleManifest<typeof tagsConfigSchema> = createTagsModule();

export default tagsModule;
