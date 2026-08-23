import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';
import { CUSTOM_ID_SEPARATOR } from '../interactions/custom-id.ts';

export const COMPONENT_TYPE_ACTION_ROW = 1;
export const COMPONENT_TYPE_BUTTON = 2;
export const COMPONENT_TYPE_STRING_SELECT = 3;

export const ACTION_ROWS_MAX = 5;
export const BUTTONS_PER_ROW_MAX = 5;

export const BUTTON_LABEL_MAX = 80;
export const BUTTON_URL_MAX = 512;

export const SELECT_OPTIONS_MAX = 25;
export const SELECT_PLACEHOLDER_MAX = 150;
export const SELECT_OPTION_LABEL_MAX = 100;
export const SELECT_OPTION_DESCRIPTION_MAX = 100;

export const COMPONENT_KEY_MAX = 32;

export const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger', 'link'] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];

export const BUTTON_STYLE_VALUES: Readonly<Record<ButtonStyle, number>> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
};

export const componentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(COMPONENT_KEY_MAX)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'must start with a letter or digit and hold only letters, digits, hyphens and underscores',
  )
  .refine((key) => !key.includes(CUSTOM_ID_SEPARATOR), {
    message: `must not contain '${CUSTOM_ID_SEPARATOR}' — it separates the segments of a custom_id`,
  });

export const ROLE_ACTION_MODES = ['toggle', 'add', 'remove'] as const;
export type RoleActionMode = (typeof ROLE_ACTION_MODES)[number];

export const REPLY_ACTION_CONTENT_MAX = 2000;

export const componentActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role'),
    mode: z.enum(ROLE_ACTION_MODES),
    roleId: snowflakeSchema,
  }),
  z.object({
    kind: z.literal('reply'),
    content: z.string().trim().min(1).max(REPLY_ACTION_CONTENT_MAX),
    ephemeral: z.boolean().default(true),
  }),
]);

export type ComponentAction = z.infer<typeof componentActionSchema>;

export const componentEmojiSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  id: snowflakeSchema.optional(),
  animated: z.boolean().optional(),
});

export type ComponentEmoji = z.infer<typeof componentEmojiSchema>;

const TAGGED_EMOJI = /^<(a)?:([A-Za-z0-9_]{2,32}):(\d{17,20})>$/;

// Two patterns rather than one with optional delimiters: a single lenient pattern reads the 'a' of
// a bare 'apple:123…' as the animated flag and names the emoji 'pple'.
const BARE_EMOJI = /^([A-Za-z0-9_]{2,32}):(\d{17,20})$/;

export function parseComponentEmoji(raw: string | undefined): ComponentEmoji | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const tagged = TAGGED_EMOJI.exec(value);
  if (tagged) {
    return {
      name: tagged[2] as string,
      id: tagged[3] as string,
      ...(tagged[1] ? { animated: true } : {}),
    };
  }

  const bare = BARE_EMOJI.exec(value);
  if (bare) return { name: bare[1] as string, id: bare[2] as string };

  return { name: value };
}

export function formatComponentEmoji(emoji: ComponentEmoji | undefined): string {
  if (!emoji) return '';
  if (emoji.id) return `<${emoji.animated ? 'a' : ''}:${emoji.name ?? '_'}:${emoji.id}>`;
  return emoji.name ?? '';
}

const NO_LABEL_OR_EMOJI = 'a button needs a label, an emoji, or both — Discord refuses a bare one.';

export const messageButtonSchema = z
  .object({
    key: componentKeySchema,
    style: z.enum(BUTTON_STYLES),
    label: z.string().trim().max(BUTTON_LABEL_MAX).optional(),
    emoji: componentEmojiSchema.optional(),
    disabled: z.boolean().optional(),
    url: z.string().max(BUTTON_URL_MAX).optional(),
    action: componentActionSchema.optional(),
  })
  .superRefine((button, ctx) => {
    if (!button.label && !button.emoji) {
      ctx.addIssue({ code: 'custom', path: ['label'], message: NO_LABEL_OR_EMOJI });
    }

    if (button.style === 'link') {
      if (!button.url) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'a link button needs the address it opens.',
        });
      } else if (!/^https?:\/\//i.test(button.url) || !URL.canParse(button.url)) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'must be a complete http:// or https:// link',
        });
      }

      if (button.action) {
        ctx.addIssue({
          code: 'custom',
          path: ['action'],
          message:
            'a link button never reaches Proton — Discord opens the address itself and sends no ' +
            'interaction — so it cannot carry an action. Use another style, or drop the action.',
        });
      }
      return;
    }

    if (button.url) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'only a link button carries an address. Change the style to Link, or clear it.',
      });
    }

    if (!button.action) {
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message:
          'this button would do nothing when pressed. Give it an action, or make it a link button.',
      });
    }
  });

export type MessageButton = z.infer<typeof messageButtonSchema>;

export const selectOptionSchema = z.object({
  key: componentKeySchema,
  label: z.string().trim().min(1).max(SELECT_OPTION_LABEL_MAX),
  description: z.string().trim().max(SELECT_OPTION_DESCRIPTION_MAX).optional(),
  emoji: componentEmojiSchema.optional(),
  default: z.boolean().optional(),
  action: componentActionSchema,
});

export type SelectOption = z.infer<typeof selectOptionSchema>;

export const messageSelectSchema = z
  .object({
    key: componentKeySchema,
    placeholder: z.string().trim().max(SELECT_PLACEHOLDER_MAX).optional(),
    minValues: z.number().int().min(0).max(SELECT_OPTIONS_MAX).optional(),
    maxValues: z.number().int().min(1).max(SELECT_OPTIONS_MAX).optional(),
    disabled: z.boolean().optional(),
    options: z.array(selectOptionSchema).min(1).max(SELECT_OPTIONS_MAX),
  })
  .superRefine((select, ctx) => {
    const seen = new Set<string>();
    for (const [index, option] of select.options.entries()) {
      if (seen.has(option.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['options', index, 'key'],
          message: `two options are both called '${option.key}' — a pick could not say which.`,
        });
      }
      seen.add(option.key);
    }

    const min = select.minValues ?? 1;
    const max = select.maxValues ?? 1;

    if (max < min) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxValues'],
        message: `at most ${max} cannot be fewer than at least ${min}.`,
      });
    }

    if (max > select.options.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxValues'],
        message:
          `this dropdown lets someone pick ${max} but only holds ${select.options.length} ` +
          'options, and Discord refuses that.',
      });
    }
  });

export type MessageSelect = z.infer<typeof messageSelectSchema>;

export const actionRowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('buttons'),
    buttons: z.array(messageButtonSchema).min(1).max(BUTTONS_PER_ROW_MAX),
  }),
  z.object({ kind: z.literal('select'), select: messageSelectSchema }),
]);

export type ActionRow = z.infer<typeof actionRowSchema>;

export function rowKeys(row: ActionRow): string[] {
  return row.kind === 'buttons'
    ? row.buttons.filter((button) => button.style !== 'link').map((button) => button.key)
    : [row.select.key];
}

export const actionRowsSchema = z
  .array(actionRowSchema)
  .max(ACTION_ROWS_MAX)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();

    for (const [index, row] of rows.entries()) {
      for (const key of rowKeys(row)) {
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message:
              `two components in this message are both keyed '${key}'. The key is what a press ` +
              'carries back, so Proton could not tell which one was pressed.',
          });
        }
        seen.add(key);
      }
    }
  });

export interface DiscordMedia {
  url: string;
}

export interface DiscordComponent {
  type: number;
  components?: DiscordComponent[];
  style?: number;
  label?: string;
  emoji?: ComponentEmoji;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
    emoji?: ComponentEmoji;
    default?: boolean;
  }>;

  content?: string;
  divider?: boolean;
  spacing?: number;
  items?: Array<{ media: DiscordMedia; description?: string; spoiler?: boolean }>;
  accessory?: DiscordComponent;
  accent_color?: number;
  spoiler?: boolean;
  media?: DiscordMedia;
  description?: string;
}

export type CustomIdFor = (key: string) => string;

export function toDiscordComponents(
  rows: readonly ActionRow[],
  customIdFor: CustomIdFor,
): DiscordComponent[] {
  return rows.map((row) => ({
    type: COMPONENT_TYPE_ACTION_ROW,
    components:
      row.kind === 'buttons'
        ? row.buttons.map((button) => ({
            type: COMPONENT_TYPE_BUTTON,
            style: BUTTON_STYLE_VALUES[button.style],
            ...(button.label ? { label: button.label } : {}),
            ...(button.emoji ? { emoji: button.emoji } : {}),
            ...(button.disabled ? { disabled: true } : {}),
            ...(button.style === 'link'
              ? { url: button.url as string }
              : { custom_id: customIdFor(button.key) }),
          }))
        : [
            {
              type: COMPONENT_TYPE_STRING_SELECT,
              custom_id: customIdFor(row.select.key),
              ...(row.select.placeholder ? { placeholder: row.select.placeholder } : {}),
              ...(row.select.minValues === undefined ? {} : { min_values: row.select.minValues }),
              ...(row.select.maxValues === undefined ? {} : { max_values: row.select.maxValues }),
              ...(row.select.disabled ? { disabled: true } : {}),
              options: row.select.options.map((option) => ({
                label: option.label,
                value: option.key,
                ...(option.description ? { description: option.description } : {}),
                ...(option.emoji ? { emoji: option.emoji } : {}),
                ...(option.default ? { default: true } : {}),
              })),
            },
          ],
  }));
}

export function findComponentAction(
  rows: readonly ActionRow[],
  key: string,
  optionKey?: string,
): ComponentAction | undefined {
  for (const row of rows) {
    if (row.kind === 'buttons') {
      const button = row.buttons.find((candidate) => candidate.key === key);
      if (button) return button.action;
      continue;
    }

    if (row.select.key !== key) continue;
    return row.select.options.find((option) => option.key === optionKey)?.action;
  }

  return undefined;
}
