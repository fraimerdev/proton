import {
  type ActionRow,
  actionRowSchema,
  durationStringSchema,
  encodeCustomId,
  formatDuration,
  interactiveKeys,
  liftLegacyMessage,
  limitFor,
  MAX_CUSTOM_ID_LENGTH,
  messageObjectSchema,
  protonFields,
  refineMessage,
  rowKeys,
  snowflakeSchema,
  tryParseDuration,
} from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'messages';

export const TEMPLATE_NAME_MAX = 32;
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_FOOTER_MAX = 2048;
export const EMBED_AUTHOR_NAME_MAX = 256;
export const EMBED_FIELDS_MAX = 25;
export const EMBED_TOTAL_MAX = 6000;
export const EMBED_COLOR_MAX = 0xffffff;
export const EMBED_URL_MAX = 2048;

export const MAX_TEMPLATES = limitFor('pro', 'savedTemplates');

export const TEMPLATE_NAMES_SHOWN = 25;
export const TEMPLATE_LIST_SHOWN = 50;

const linkSchema = z
  .string()
  .max(EMBED_URL_MAX)
  .refine((value) => /^https?:\/\//i.test(value) && URL.canParse(value), {
    message: 'must be a complete http:// or https:// link',
  });

export const embedFieldSchema = z.object({
  name: z.string().trim().min(1).max(EMBED_FIELD_NAME_MAX),
  value: z.string().trim().min(1).max(EMBED_FIELD_VALUE_MAX),
  inline: z.boolean().optional(),
});

export type EmbedField = z.infer<typeof embedFieldSchema>;

export const embedContentSchema = z.object({
  title: z.string().max(EMBED_TITLE_MAX).optional(),
  description: z.string().max(EMBED_DESCRIPTION_MAX).optional(),
  url: linkSchema.optional(),
  color: z.number().int().min(0).max(EMBED_COLOR_MAX).optional(),
  imageUrl: linkSchema.optional(),
  thumbnailUrl: linkSchema.optional(),
  footer: z.string().max(EMBED_FOOTER_MAX).optional(),
  authorName: z.string().max(EMBED_AUTHOR_NAME_MAX).optional(),
  timestamp: z.boolean().optional(),
  fields: z.array(embedFieldSchema).max(EMBED_FIELDS_MAX).optional(),
});

export type EmbedContent = z.infer<typeof embedContentSchema>;

export const templateContentSchema = embedContentSchema.extend({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
});

export type Template = z.infer<typeof templateContentSchema>;

export const savedMessageNameSchema = z.string().trim().min(1).max(TEMPLATE_NAME_MAX);

export const SCHEDULE_MODES = ['once', 'repeat'] as const;

export const MIN_REPEAT_MS = 60_000;

export const SCHEDULE_HELP =
  'A scheduled template posts at an exact start time and, when it repeats, on an interval such ' +
  'as `24h` or `7d` — Proton books one explicit next run rather than reading a cron expression.';

export const templateScheduleSchema = z
  .object({
    channelId: snowflakeSchema,

    at: z.iso.datetime({
      offset: true,
      error:
        'must be a complete ISO timestamp carrying a timezone, such as 2026-01-31T09:00:00Z — ' +
        'without one there is no way to tell which server\u2019s 09:00 was meant.',
    }),

    mode: z.enum(SCHEDULE_MODES).default('once'),

    every: durationStringSchema
      .refine((value) => (tryParseDuration(value) ?? 0) >= MIN_REPEAT_MS, {
        error: `a template repeats at most once every ${formatDuration(MIN_REPEAT_MS)} — anything faster would exhaust the channel\u2019s rate limit and stall Proton\u2019s other messages there.`,
      })
      .optional(),

    pingRoleId: snowflakeSchema.optional(),

    enabled: z.boolean().default(true),
  })
  .superRefine((schedule, ctx) => {
    if (schedule.mode === 'repeat' && schedule.every === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['every'],
        message:
          'a repeating template needs an interval \u2014 how long Proton waits before posting it ' +
          'again, such as 24h or 7d.',
      });
    }
  });

export type TemplateSchedule = z.infer<typeof templateScheduleSchema>;

export const savedMessageSchema = z.preprocess(
  liftLegacyMessage,
  messageObjectSchema
    .extend({
      name: savedMessageNameSchema,

      // Absent means the template is only ever posted on request. The schedule is what the
      // retired announcements module used to own.
      schedule: templateScheduleSchema.optional(),
    })
    .superRefine(refineMessage),
);

export type SavedMessage = z.infer<typeof savedMessageSchema>;

export function normaliseTemplateName(raw: string): string {
  return raw.trim().toLowerCase();
}

export function encodedLength(messageName: string, key: string): number {
  const encoded = encodeCustomId(MODULE_ID, normaliseTemplateName(messageName), key);
  return encoded.ok ? encoded.customId.length : encoded.length;
}

export const templatesSchema = z
  .array(savedMessageSchema)
  .max(MAX_TEMPLATES)
  .superRefine((saved, ctx) => {
    const seen = new Set<string>();
    for (const [index, message] of saved.entries()) {
      const key = normaliseTemplateName(message.name);
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message:
            `two saved messages are both called '${message.name}' — /message post could not say ` +
            'which of them you meant',
        });
      }
      seen.add(key);

      for (const componentKey of interactiveKeys(message)) {
        const length = encodedLength(message.name, componentKey);
        if (length > MAX_CUSTOM_ID_LENGTH) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'components'],
            message:
              `the name '${message.name}' and the component key '${componentKey}' need ${length} ` +
              `characters together with Proton's prefix, and Discord allows a custom_id of ` +
              `${MAX_CUSTOM_ID_LENGTH}. Shorten the message name or the key.`,
          });
        }
      }
    }
  });

export const COMPONENT_NAME_MAX = 48;

export const MAX_SAVED_COMPONENTS = 25;

// A palette entry is a whole row, not a lone button: `components` on a message is an array of rows,
// so a row is what can be dropped in without asking which row to drop it into.
export const savedComponentSchema = z.object({
  name: z.string().trim().min(1).max(COMPONENT_NAME_MAX),
  row: actionRowSchema,
});

export type SavedComponent = z.infer<typeof savedComponentSchema>;

export const savedComponentsSchema = z
  .array(savedComponentSchema)
  .max(MAX_SAVED_COMPONENTS)
  .superRefine((saved, ctx) => {
    const seen = new Set<string>();

    for (const [index, component] of saved.entries()) {
      const key = component.name.trim().toLowerCase();

      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message:
            `two saved components are both called '${component.name}' — the palette could not ` +
            'say which of them you were inserting.',
        });
      }
      seen.add(key);
    }
  });

// Inserting is a copy, never a reference: a template that pointed at a palette entry would empty
// its own row when that entry was deleted, and the keys have to be freshened against the template
// they land in anyway — the same key twice in one message is unroutable.
export function withFreshKeys(row: ActionRow, taken: ReadonlySet<string>): ActionRow {
  const claimed = new Set(taken);

  const fresh = (key: string): string => {
    if (!claimed.has(key)) {
      claimed.add(key);
      return key;
    }

    for (let n = 2; ; n += 1) {
      const candidate = `${key}-${n}`;
      if (claimed.has(candidate)) continue;

      claimed.add(candidate);
      return candidate;
    }
  };

  return row.kind === 'select'
    ? { kind: 'select', select: { ...row.select, key: fresh(row.select.key) } }
    : { kind: 'buttons', buttons: row.buttons.map((b) => ({ ...b, key: fresh(b.key) })) };
}

export function componentKeys(row: ActionRow): string[] {
  return rowKeys(row);
}

export const messagesConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Who may run /message is set in the Permissions module',
  }),

  templates: templatesSchema.default([]),

  components: savedComponentsSchema.default([]),
});

export type MessagesConfig = z.infer<typeof messagesConfigSchema>;

export const messagesFormSchema = messagesConfigSchema.omit({ templates: true, components: true });

export const messagesDefaultConfig: MessagesConfig = {
  enabled: false,
  templates: [],
  components: [],
};

export const MESSAGES_SCHEMA_VERSION = 4;

// Zod strips what it does not know, so a config still carrying `saved` would parse to an empty
// template list and the next write would persist that loss. The 0017 migration rewrites the stored
// rows; this catches a row that migration never reached — a restored dump, or a write that raced
// the deploy.
export function liftSavedEmbeds(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;

  const source = raw as Record<string, unknown>;
  if (!Object.hasOwn(source, 'saved') || Object.hasOwn(source, 'templates')) return raw;

  const { saved, ...rest } = source;
  return { ...rest, templates: saved };
}

export function findTemplate(
  saved: readonly SavedMessage[],
  name: string,
): SavedMessage | undefined {
  const wanted = normaliseTemplateName(name);
  return saved.find((message) => normaliseTemplateName(message.name) === wanted);
}

export function suggestTemplateNames(
  saved: readonly SavedMessage[],
  typed: string,
  limit: number,
): string[] {
  const needle = normaliseTemplateName(typed);

  return saved
    .map((message) => message.name)
    .filter((name) => normaliseTemplateName(name).includes(needle))
    .sort((a, b) => {
      const rank =
        Number(!normaliseTemplateName(a).startsWith(needle)) -
        Number(!normaliseTemplateName(b).startsWith(needle));
      return rank !== 0 ? rank : a.localeCompare(b);
    })
    .slice(0, limit);
}

export function renderNames(names: readonly string[], shown = TEMPLATE_NAMES_SHOWN): string {
  const listed = names.slice(0, shown).map((name) => `\`${name}\``);
  const hidden = names.length - listed.length;

  return hidden > 0 ? `${listed.join(', ')} and ${hidden} more` : listed.join(', ');
}
