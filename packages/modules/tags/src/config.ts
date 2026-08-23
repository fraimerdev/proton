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
    return { ok: false, humanReason: 'A tag needs a name — that one was empty.' };
  }

  if (name.length > TAG_NAME_MAX) {
    return {
      ok: false,
      humanReason: `Tag names are capped at ${TAG_NAME_MAX} characters and “${name}” is ${name.length}.`,
    };
  }

  if (!TAG_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      humanReason:
        `“${name}” is not a usable tag name. Use letters, digits, dots, dashes and ` +
        'underscores, starting with a letter or a digit — spaces become dashes.',
    };
  }

  return { ok: true, name };
}

export const tagsConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Who may create and edit tags is set in the Permissions module',
  }),

  ephemeral: z.boolean().default(false).register(protonFields, {
    label: 'Show tags only to whoever asked',
  }),

  allowMentions: z.boolean().default(false).register(protonFields, {
    label: 'Let tag text ping people',
    description: 'A stored @everyone becomes pingable by any member',
  }),
});

export type TagsConfig = z.infer<typeof tagsConfigSchema>;

export const tagsDefaultConfig: TagsConfig = {
  enabled: false,
  ephemeral: false,
  allowMentions: false,
};

export const TAGS_SCHEMA_VERSION = 1;
