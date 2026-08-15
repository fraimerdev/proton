import { MAX_CUSTOM_ID_LENGTH, protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';
import { CUSTOM_ID_SEPARATOR, encodeCustomId, SELECT_BINDING_KEY } from './custom-id.ts';

/**
 * How a menu asks to be pressed.
 *
 * `reaction` attaches to a message that already exists and is matched on
 * `(channel, message, emoji)`; `button` and `select` are messages Proton itself
 * posts, addressed by `custom_id`. The distinction is not cosmetic — it decides
 * which event type carries the choice, which is why it lives in config rather
 * than being inferred from whether `messageId` happens to be set.
 */
export const ROLEMENU_KINDS = ['reaction', 'button', 'select'] as const;
export type RolemenuKind = (typeof ROLEMENU_KINDS)[number];

/**
 * What choosing an option means.
 *
 *  - `toggle` — the classic: pick it up, pick it again to put it down.
 *  - `add-only` — grant, never revoke. For roles a member may opt into but not
 *    out of (a pronoun role they can still remove by hand; an "I read the rules"
 *    marker they should not be able to un-say by misclicking).
 *  - `unique` — grant this one and drop every other role bound in the same menu.
 *    A colour picker, where holding two answers at once is not a state anybody
 *    wanted.
 */
export const ROLEMENU_MODES = ['toggle', 'add-only', 'unique'] as const;
export type RolemenuMode = (typeof ROLEMENU_MODES)[number];

/**
 * 25 bindings, not the 40 components a message may carry.
 *
 * A string select accepts at most 25 options (verified against
 * docs.discord.com, August 2026), and 25 buttons is exactly five full rows of
 * five. Capping every kind at the tightest of the three keeps one number for an
 * admin to know, and means changing a menu's `kind` can never turn a valid menu
 * into a message Discord refuses to accept.
 */
export const MAX_BINDINGS_PER_MENU = 25;

/** Menus per guild. A guild needing more than this wants a second channel, not a longer list. */
export const MAX_MENUS = 25;

export const MENU_ID_MAX = 64;
export const BINDING_KEY_MAX = 64;
/** Button labels cap at 80; select option labels at 100. The tighter of the two serves both. */
export const BINDING_LABEL_MAX = 80;

/**
 * A menu id is a slug, and the separator is the reason.
 *
 * It goes into a `custom_id` as its own segment, so an id containing a colon
 * would produce an id that parses into the wrong menu — silently, and only for
 * the menus whose ids contained one.
 */
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
      `must not contain '${CUSTOM_ID_SEPARATOR}' — it separates the segments of a custom_id, ` +
      'and a key containing one would resolve to the wrong choice',
  })
  .refine((key) => key !== SELECT_BINDING_KEY, {
    message: `'${SELECT_BINDING_KEY}' is reserved for a dropdown's own custom_id`,
  });

export const rolemenuBindingSchema = z.object({
  /**
   * What the member pressed, as this menu names it.
   *
   * For a `reaction` menu it is the emoji: the unicode character for a standard
   * one, and the **id** for a custom one — matching what the gateway normaliser
   * puts in a reaction's natural key, so two custom emoji sharing a name stay
   * distinct. For `button` and `select` menus it is a short slug of the admin's
   * choosing that ends up inside the `custom_id`.
   */
  key: bindingKeySchema,
  roleId: snowflakeSchema,
  /** Shown on the button or dropdown option. Falls back to the key, which is the emoji for reaction menus. */
  label: z.string().min(1).max(BINDING_LABEL_MAX).optional(),
});

export type RolemenuBinding = z.infer<typeof rolemenuBindingSchema>;

export const rolemenuMenuSchema = z
  .object({
    id: menuIdSchema,
    channelId: snowflakeSchema,
    /**
     * The message the menu lives on.
     *
     * Required for a `reaction` menu and optional for the other two, because for
     * a reaction menu it is the only way to recognise the menu at all — a
     * reaction dispatch carries a channel, a message and an emoji and nothing
     * else. A button or dropdown press names its menu in the `custom_id`, so the
     * message id is only needed there to *refresh* an already-posted menu rather
     * than post a second copy of it.
     */
    messageId: snowflakeSchema.optional(),
    kind: z.enum(ROLEMENU_KINDS),
    mode: z.enum(ROLEMENU_MODES),
    bindings: z.array(rolemenuBindingSchema).min(1).max(MAX_BINDINGS_PER_MENU),
  })
  .superRefine((menu, ctx) => {
    // Two bindings sharing a key make resolution ambiguous, and the ambiguity is
    // resolved by whichever one is listed first — so the second is dead config
    // that looks live. Refused on write, where the admin can see which key.
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

      /**
       * A menu that cannot address its own buttons has to be refused here.
       *
       * Discord truncates nothing: it rejects the whole message, so the failure
       * would arrive as `/rolemenu` not working, long after the save that caused
       * it. The check runs for reaction menus too even though they build no
       * `custom_id` — changing `kind` is one dropdown away, and a menu that
       * becomes unpostable by having its kind changed is a worse surprise than a
       * key length refused up front.
       */
      const encoded = encodeCustomId(menu.id, binding.key).length;
      if (encoded > MAX_CUSTOM_ID_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          path: ['bindings', index, 'key'],
          message:
            `menu id '${menu.id}' and key '${binding.key}' need ${encoded} characters together ` +
            `with Proton's prefix, and Discord allows a custom_id of ${MAX_CUSTOM_ID_LENGTH}. ` +
            'Shorten the menu id or the key.',
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
    // Menu ids address menus from inside a `custom_id`, so a duplicate would send
    // every press of the second menu to the first one's bindings.
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

/**
 * Role-menu configuration (PLAN.md §8, Phase 3).
 *
 * `menus` is an array of objects, which PLAN.md §9 puts explicitly outside the
 * v1 form generator: it supports flat arrays of scalars and objects nesting one
 * level, not arrays of objects. `zodToDescriptors` therefore throws on this
 * schema, and that is the intended behaviour rather than a gap to widen the
 * generator over — §9 rules that out in as many words, and `cases` has the same
 * shape for the same reason.
 *
 * The menus still live in config, because they are per-guild data that has to be
 * validated on every read and write (I5) and diffed for the audit trail (I7).
 * `rolemenuFormSchema` below is what the dashboard generates fields from; the
 * menus get a bespoke editor, exactly as the escalation ladder did.
 */
export const rolemenuConfigSchema = z.object({
  /**
   * Off by default.
   *
   * An enabled role menu hands out roles to anyone who can see the message, and
   * before an admin has chosen which roles that is a permission escalation with
   * Proton's name on it (§15). A guild that installs Proton and ignores this
   * module gets nothing at all.
   */
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Let members give themselves roles from the menus configured below.',
  }),

  // Deliberately not registered with `protonFields`: no v1 field kind describes
  // an array of objects, and a metadata hint would only make the generator's
  // refusal look like a bug rather than the documented boundary it is.
  menus: rolemenuMenusSchema.default([]),
});

export type RolemenuConfig = z.infer<typeof rolemenuConfigSchema>;

/**
 * The subset the dashboard's form generator can build (PLAN.md §9).
 *
 * Derived by omission rather than written out a second time, so a field added to
 * the config appears on the form automatically and the two cannot drift.
 * Anything omitted here is a promise that a bespoke editor exists for it.
 */
export const rolemenuFormSchema = rolemenuConfigSchema.omit({ menus: true });

/**
 * Defaults that give nobody a role.
 *
 * No menus, because there is no role every guild has and inventing one would
 * have Proton hand out a role the admin never chose.
 */
export const rolemenuDefaultConfig: RolemenuConfig = {
  enabled: false,
  menus: [],
};

/** Bumped whenever the shape above changes (I5). */
export const ROLEMENU_SCHEMA_VERSION = 1;

/** The menu with this id, or null. Used by the listeners and by `/rolemenu`. */
export function findMenu(config: RolemenuConfig, menuId: string): RolemenuMenu | null {
  return config.menus.find((menu) => menu.id === menuId) ?? null;
}
