import type { PermissionsConfig } from './config.ts';

/** The id `apps/worker` looks up when it consults these overrides. */
export const PERMISSIONS_MODULE_ID = 'permissions';

/**
 * How many roles a refusal names before it stops listing them.
 *
 * An interaction reply is capped at 2000 characters, and a refusal that
 * overflowed the cap would be rejected by the executor's payload validation —
 * leaving the invoker with nothing at all, which is the outcome this module
 * exists to avoid.
 */
export const MAX_LISTED_ROLES = 5;

export interface CommandRefusal {
  code: 'missing_required_role';
  commandName: string;
  requiredRoleIds: string[];
  /** Shown to the invoker verbatim: names the role, and where to change it (§1). */
  humanReason: string;
}

export type CommandGateDecision = { allowed: true } | { allowed: false; refusal: CommandRefusal };

export interface CommandGateInput {
  commandName: string;
  /** `d.member.roles` from the interaction — the invoker's roles, per Discord. */
  memberRoleIds: readonly string[];
  config: PermissionsConfig;
}

/** The roles a guild requires for a command, or none if it set no override. */
export function requiredRolesFor(config: PermissionsConfig, commandName: string): string[] {
  return config.overrides[commandName] ?? [];
}

/**
 * May this member run this command in this guild?
 *
 * Pure, and deliberately so: the decision is taken in `apps/worker`'s runtime
 * before a handler is dispatched (a module cannot gate another module's command
 * — I3), so everything this module contributes is a function of the config and
 * the interaction's own `member.roles`.
 *
 * Semantics follow Discord's own command permissions: the requirement applies to
 * everyone, administrators and the guild owner included. A bypass would make the
 * override a suggestion, and "it applies to everyone except some people" is not
 * something an admin can reason about from a role list.
 */
export function evaluateCommandGate(input: CommandGateInput): CommandGateDecision {
  if (!input.config.enabled) return { allowed: true };

  const required = requiredRolesFor(input.config, input.commandName);

  // An empty list means "no requirement", not "nobody". A dashboard role picker
  // emptied of its last role must relax the override rather than lock the
  // command for the entire guild.
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

/**
 * Name the role, and say where the requirement came from.
 *
 * Role mentions are used because Discord renders them as the role's name, which
 * is what an admin recognises; the raw ids follow it because a deleted role
 * renders as `@deleted-role` and because the id is what identifies the override
 * in the dashboard. Mentioning is safe here: the reply is ephemeral, so it is
 * delivered to the invoker alone and pings nobody.
 */
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
    `in the dashboard under Permissions → /${commandName}. ` +
    `(required role ${listed.length === 1 ? 'id' : 'ids'}: ${listed.join(', ')})`
  );
}
