import { type PermissionsConfig, RETIRED_COMMAND_ALIASES } from './config.ts';

export const PERMISSIONS_MODULE_ID = 'permissions';

export const MAX_LISTED_ROLES = 5;

export interface CommandRefusal {
  code: 'missing_required_role';
  commandName: string;
  requiredRoleIds: string[];

  humanReason: string;
}

export type CommandGateDecision = { allowed: true } | { allowed: false; refusal: CommandRefusal };

export interface CommandGateInput {
  commandName: string;

  memberRoleIds: readonly string[];
  config: PermissionsConfig;
}

export function requiredRolesFor(config: PermissionsConfig, commandName: string): string[] {
  const own = config.overrides[commandName];
  if (own && own.length > 0) return own;

  // The worker parses stored config directly, so it never sees liftStoredConfig — without this
  // fold, retiring /untimeout would drop the gate an admin set on it until they saved the page.
  for (const [retired, survivor] of Object.entries(RETIRED_COMMAND_ALIASES)) {
    if (survivor !== commandName) continue;

    const inherited = config.overrides[retired];
    if (inherited && inherited.length > 0) return inherited;
  }

  return own ?? [];
}

export function evaluateCommandGate(input: CommandGateInput): CommandGateDecision {
  if (!input.config.enabled) return { allowed: true };

  const required = requiredRolesFor(input.config, input.commandName);

  if (required.length === 0) return { allowed: true };

  const held = new Set(input.memberRoleIds);
  if (required.some((roleId) => held.has(roleId))) return { allowed: true };

  return {
    allowed: false,
    refusal: {
      code: 'missing_required_role',
      commandName: input.commandName,
      requiredRoleIds: [...required],
      humanReason: describeRefusal(input.commandName, required),
    },
  };
}

function describeRefusal(commandName: string, required: readonly string[]): string {
  const listed = required.slice(0, MAX_LISTED_ROLES);
  const overflow = required.length - listed.length;
  const mentions = listed.map((id) => `<@&${id}>`).join(', ');
  const more = overflow > 0 ? `, or ${overflow} other role${overflow === 1 ? '' : 's'}` : '';

  const roles =
    required.length === 1 ? `the ${mentions} role` : `one of these roles: ${mentions}${more}`;

  return (
    `You need ${roles} to use /${commandName} in this server. ` +
    'This is a Proton command override, not a Discord permission — a server admin can change it ' +
    `in the dashboard under Permissions → /${commandName}.`
  );
}
