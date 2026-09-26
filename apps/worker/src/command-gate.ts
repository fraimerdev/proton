import type { Logger, ModuleRegistry } from '@proton/core';
import { describeError } from '@proton/db';
import type { CommandGateResult } from '@proton/module-moderation';
import {
  evaluateCommandGate,
  PERMISSIONS_MODULE_ID,
  permissionsConfigSchema,
} from '@proton/module-permissions';
import type { ConfigProvider, ModuleConfigSnapshot } from './runtime.ts';

export interface CommandGateDeps {
  registry: Pick<ModuleRegistry, 'get'>;
  config: ConfigProvider;
  logger: Logger;
  displayName?(guildId: string, key: string): Promise<string>;
}

export function createCommandGate(
  deps: CommandGateDeps,
): (
  guildId: string,
  commandName: string,
  roleIds: readonly string[],
) => Promise<CommandGateResult> {
  const nameOf = async (guildId: string, key: string): Promise<string> => {
    try {
      return (await deps.displayName?.(guildId, key)) || key;
    } catch {
      return key;
    }
  };

  return async (guildId, commandName, roleIds) => {
    if (!deps.registry.get(PERMISSIONS_MODULE_ID)) return { allowed: true };

    let snapshot: ModuleConfigSnapshot;
    try {
      snapshot = await deps.config.get(guildId, PERMISSIONS_MODULE_ID);
    } catch (error) {
      deps.logger.warn(
        `could not read the permissions settings, so a punishment gated like /${commandName} ` +
          `was refused rather than let through unchecked: ${describeError(error)}`,
        { guildId, commandName },
      );
      return {
        allowed: false,
        message:
          `I couldn't read this server's Permissions settings, so I couldn't check who can use ` +
          `/${await nameOf(guildId, commandName)}. Nothing was done. Try again in a moment.`,
      };
    }
    if (!snapshot.enabled) return { allowed: true };

    const parsed = permissionsConfigSchema.safeParse(snapshot.config);
    if (!parsed.success) {
      deps.logger.warn(
        'invalid stored config for permissions — command overrides are NOT being applied to ' +
          `/${commandName} punishments in this guild`,
        { guildId, commandName },
      );
      return { allowed: true };
    }

    const decision = evaluateCommandGate({
      commandName,
      displayName: await nameOf(guildId, commandName),
      memberRoleIds: roleIds,
      config: parsed.data,
    });

    return decision.allowed
      ? { allowed: true }
      : { allowed: false, message: decision.refusal.humanReason };
  };
}
