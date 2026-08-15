import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

/**
 * Discord's shape for an application command name: 1-32 characters, lowercase,
 * no spaces and no leading slash.
 *
 * Keys are checked against it because a key that could never name a command is
 * an override that can never fire, and its only symptom would be silence —
 * which §1 classes as a bug. Refusing it on write puts the mistake in front of
 * the admin who made it.
 */
const COMMAND_NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

function isCommandName(key: string): boolean {
  return COMMAND_NAME.test(key) && key === key.toLowerCase();
}

/**
 * Command name → the roles allowed to run it.
 *
 * A catch-all object rather than a fixed shape, because the commands a guild can
 * restrict are whatever the loaded modules registered — runtime data that no
 * static schema can enumerate, and that this module must not learn by importing
 * the modules that own those commands (I3).
 *
 * The consequence is that `zodToDescriptors` emits nothing for this field: the
 * v1 vocabulary (PLAN.md §9) has no `record` kind, so there is no descriptor
 * that says "one role picker per key". `commandOverridesFormSchema` below builds
 * the renderable schema instead, from the live command list.
 */
export const commandOverridesSchema = z
  .object({})
  .catchall(z.array(snowflakeSchema))
  .refine((overrides) => Object.keys(overrides).every(isCommandName), {
    message:
      'override keys must be Discord command names: lowercase, 1-32 characters, no spaces and ' +
      "no leading slash — 'ban', not '/Ban'",
  });

export type CommandOverrides = z.infer<typeof commandOverridesSchema>;

export const permissionsConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Apply this server’s command overrides. Off means Discord’s own rules alone.',
  }),

  /**
   * Deliberately not registered with `protonFields`: no v1 field kind describes
   * a map, and a metadata hint would make the generator's silence look like a
   * bug rather than the documented boundary it is.
   */
  overrides: commandOverridesSchema.default({}),
});

export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;

export const permissionsDefaultConfig: PermissionsConfig = {
  enabled: true,
  // No overrides out of the box: Proton must not narrow who can use a command
  // until a guild says so, or installing it would silently break moderation.
  overrides: {},
};

/** Bumped whenever the shape above changes (I5). */
export const PERMISSIONS_SCHEMA_VERSION = 1;

/**
 * The renderable half of `overrides`, built from the commands actually loaded.
 *
 * `zodToDescriptors` walks a schema's static shape, and the override map has
 * none — so the dashboard passes the registry's command names through here and
 * gets one `role-id` array field per command, which is a control the v1
 * generator already knows how to render. Generated rather than hand-written so
 * a module shipping a new command gets an override row for free.
 */
export function commandOverridesFormSchema(
  commandNames: readonly string[],
): z.ZodObject<z.ZodRawShape> {
  return z.object(
    Object.fromEntries(
      commandNames.map((name) => [
        name,
        z
          .array(snowflakeSchema)
          .default([])
          .register(protonFields, {
            field: 'role-id',
            label: `/${name}`,
            description: `Roles allowed to use /${name}. Empty means Discord’s own rules apply.`,
          }),
      ]),
    ),
  );
}
