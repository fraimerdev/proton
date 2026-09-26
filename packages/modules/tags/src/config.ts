import { protonFields } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'tags';

export const TAG_NAME_MAX = 32;
export const TAG_CONTENT_MAX = 2000;

export const TAG_LIST_PAGE_SIZE = 25;

const TAG_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export type TagNameResult = { ok: true; name: string } | { ok: false; humanReason: string };

// Recall has to find what create stored, and Discord hands back whatever case the member typed —
// so the name is normalised once here and both paths go through it.
export function normaliseTagName(raw: string): TagNameResult {
  const name = raw.trim().toLowerCase().replace(/\s+/g, '-');

  if (name.length === 0) {
    return { ok: false, humanReason: 'The tag name can’t be empty.' };
  }

  if (name.length > TAG_NAME_MAX) {
    return {
      ok: false,
      humanReason: `Tag names can be up to ${TAG_NAME_MAX} characters, and “${name}” has ${name.length}.`,
    };
  }

  if (!TAG_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      humanReason:
        `“${name}” isn’t a valid tag name. Use letters, numbers, dots, dashes and underscores, ` +
        'and start with a letter or number. Spaces become dashes.',
    };
  }

  return { ok: true, name };
}

export const tagsConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Set who can use /tags in Permissions.',
  }),

  ephemeral: z.boolean().default(false).register(protonFields, {
    label: 'Reply privately',
  }),

  allowMentions: z.boolean().default(false).register(protonFields, {
    label: 'Allow pings',
    description: 'Let mentions in tags notify the members and roles they name.',
  }),
});

export type TagsConfig = z.infer<typeof tagsConfigSchema>;

export const tagsDefaultConfig: TagsConfig = {
  enabled: false,
  ephemeral: false,
  allowMentions: false,
};

export const TAGS_SCHEMA_VERSION = 1;
