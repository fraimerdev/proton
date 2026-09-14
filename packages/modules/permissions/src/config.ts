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
    description: 'Switch off to use Discord’s own command permissions instead.',
  }),

  overrides: commandOverridesSchema.default({}),
});

export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;

// Commands that used to be their own top-level name and are now a subcommand of the one they map
// to. An override left on a retired key would gate nothing, so it is read as the survivor's.
//
// A guild that gated the two halves differently cannot keep both: the gate only ever sees the
// top-level command name, so one list has to win and the other is dropped. The survivor's wins,
// which widens the lift (/timeout remove now admits whoever could /timeout add) rather than the
// punishment — the safer of the two directions, and the only one where nobody gains the ability
// to act *against* a member they could not act against before.
export const RETIRED_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  untimeout: 'timeout',
  unquarantine: 'quarantine',
  unlock: 'lockdown',
};

export function liftStoredConfig(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;

  const config = raw as Record<string, unknown>;
  const stored = config.overrides;
  if (typeof stored !== 'object' || stored === null) return raw;

  const overrides = { ...(stored as Record<string, unknown>) };
  let changed = false;

  for (const [retired, survivor] of Object.entries(RETIRED_COMMAND_ALIASES)) {
    if (!(retired in overrides)) continue;

    const inherited = overrides[retired];
    delete overrides[retired];
    changed = true;

    if (!Array.isArray(overrides[survivor]) || (overrides[survivor] as unknown[]).length === 0) {
      overrides[survivor] = inherited;
    }
  }

  return changed ? { ...config, overrides } : raw;
}

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
            description: 'Leave empty to use Discord’s own command permissions.',
          }),
      ]),
    ),
  );
}
