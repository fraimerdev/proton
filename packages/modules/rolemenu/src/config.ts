import {
  CUSTOM_ID_SEPARATOR,
  encodeCustomId,
  MAX_CUSTOM_ID_LENGTH,
  protonFields,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'rolemenu';

export const SELECT_BINDING_KEY = '*';

export const ROLEMENU_KINDS = ['reaction', 'button', 'select'] as const;
export type RolemenuKind = (typeof ROLEMENU_KINDS)[number];

export const ROLEMENU_MODES = ['toggle', 'add-only', 'unique'] as const;
export type RolemenuMode = (typeof ROLEMENU_MODES)[number];

export const MAX_BINDINGS_PER_MENU = 25;

export const MAX_MENUS = 25;

export const MENU_ID_MAX = 64;
export const BINDING_KEY_MAX = 64;

export const BINDING_LABEL_MAX = 80;

const menuIdSchema = z
  .string()
  .min(1)
  .max(MENU_ID_MAX)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'must start with a letter or digit and contain only letters, digits, hyphens and underscores',
  );

const bindingKeySchema = z
  .string()
  .min(1)
  .max(BINDING_KEY_MAX)
  .refine((key) => !key.includes(CUSTOM_ID_SEPARATOR), {
    message:
      `must not contain '${CUSTOM_ID_SEPARATOR}' — Proton reserves it to tell choices apart, ` +
      'and a key containing one would resolve to the wrong role',
  })
  .refine((key) => key !== SELECT_BINDING_KEY, {
    message: `'${SELECT_BINDING_KEY}' is reserved — Proton uses it for the dropdown itself`,
  });

export const rolemenuBindingSchema = z.object({
  key: bindingKeySchema,
  roleId: snowflakeSchema,

  label: z.string().min(1).max(BINDING_LABEL_MAX).optional(),
});

export type RolemenuBinding = z.infer<typeof rolemenuBindingSchema>;

export const rolemenuMenuSchema = z
  .object({
    id: menuIdSchema,
    channelId: snowflakeSchema,

    messageId: snowflakeSchema.optional(),
    kind: z.enum(ROLEMENU_KINDS),
    mode: z.enum(ROLEMENU_MODES),
    bindings: z.array(rolemenuBindingSchema).min(1).max(MAX_BINDINGS_PER_MENU),
  })
  .superRefine((menu, ctx) => {
    const seen = new Set<string>();
    for (const [index, binding] of menu.bindings.entries()) {
      if (seen.has(binding.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'key'],
          message: `duplicate binding key '${binding.key}' — only the first would ever be reachable`,
        });
      }
      seen.add(binding.key);

      const encoded = encodeCustomId(MODULE_ID, menu.id, binding.key);
      if (!encoded.ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'key'],
          message:
            `menu id '${menu.id}' and key '${binding.key}' need ${encoded.length} characters ` +
            `together with Proton's prefix, and Discord only allows ` +
            `${MAX_CUSTOM_ID_LENGTH} behind a button. Shorten the menu id or the key.`,
        });
      }
    }

    if (menu.kind === 'reaction' && !menu.messageId) {
      ctx.addIssue({
        code: 'custom',
        path: ['messageId'],
        message:
          'a reaction menu needs the id of the message it reacts to — a reaction only tells ' +
          'Proton the channel, the message and the emoji, so without it the menu can never be ' +
          'recognised. Turn on Developer Mode in Discord and copy the message id.',
      });
    }
  });

export type RolemenuMenu = z.infer<typeof rolemenuMenuSchema>;

export const rolemenuMenusSchema = z
  .array(rolemenuMenuSchema)
  .max(MAX_MENUS)
  .superRefine((menus, ctx) => {
    const seen = new Set<string>();
    for (const [index, menu] of menus.entries()) {
      if (seen.has(menu.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate menu id '${menu.id}' — a button cannot say which of the two it means`,
        });
      }
      seen.add(menu.id);
    }
  });

export const rolemenuConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
  }),

  menus: rolemenuMenusSchema.default([]),
});

export type RolemenuConfig = z.infer<typeof rolemenuConfigSchema>;

export const rolemenuFormSchema = rolemenuConfigSchema.omit({ menus: true });

export const rolemenuDefaultConfig: RolemenuConfig = {
  enabled: false,
  menus: [],
};

export const ROLEMENU_SCHEMA_VERSION = 1;

export function findMenu(config: RolemenuConfig, menuId: string): RolemenuMenu | null {
  return config.menus.find((menu) => menu.id === menuId) ?? null;
}
