import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

const COMMAND_NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

function isCommandName(key: string): boolean {
  return COMMAND_NAME.test(key) && key === key.toLowerCase();
}

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
    description: 'Off falls back to Discord’s own command permissions',
  }),

  overrides: commandOverridesSchema.default({}),
});

export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;

export const permissionsDefaultConfig: PermissionsConfig = {
  enabled: true,

  overrides: {},
};

export const PERMISSIONS_SCHEMA_VERSION = 1;

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
            description: 'Empty falls back to Discord’s own command permissions',
          }),
      ]),
    ),
  );
}
