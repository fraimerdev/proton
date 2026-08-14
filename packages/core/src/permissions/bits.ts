import { PermissionFlagsBits } from 'discord-api-types/v10';

/**
 * Permission bit values.
 *
 * Sourced from `discord-api-types` rather than transcribed by hand: a mistyped
 * bit is a silent authorisation bug, and the 2026 permission splits pushed
 * several values above 1<<50 where a typo is very hard to spot. `bits.test.ts`
 * pins the values PLAN.md §10.3 depends on, so an upstream change or a version
 * bump that moved them would fail the build rather than quietly mis-authorise.
 *
 * Everything here is `bigint`. Bits at 1<<51 and above exceed
 * Number.MAX_SAFE_INTEGER, so `number` arithmetic silently corrupts them.
 */
export const Permissions = PermissionFlagsBits;

export type PermissionName = keyof typeof PermissionFlagsBits;

export const ALL_PERMISSIONS: bigint = Object.values(PermissionFlagsBits).reduce(
  (acc, bit) => acc | bit,
  0n,
);

export const NO_PERMISSIONS = 0n;

/**
 * Permissions a timed-out member keeps. Discord strips everything else for the
 * duration of the timeout regardless of their roles.
 */
export const TIMEOUT_ALLOWED_PERMISSIONS: bigint =
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

export function has(permissions: bigint, required: bigint): boolean {
  return (permissions & required) === required;
}

/** True if `permissions` grants `required`, treating ADMINISTRATOR as granting all. */
export function hasWithAdmin(permissions: bigint, required: bigint): boolean {
  if ((permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) {
    return true;
  }
  return has(permissions, required);
}

/** Which of `required` are missing from `permissions` — drives "the bot lacks X" errors. */
export function missing(permissions: bigint, required: bigint): bigint {
  return required & ~permissions;
}

/** Human-readable names for a bitfield, for admin-facing error messages (§1). */
export function permissionNames(permissions: bigint): PermissionName[] {
  const names: PermissionName[] = [];
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
    if ((permissions & bit) === bit && bit !== 0n) names.push(name as PermissionName);
  }
  return names;
}

/**
 * Combine the permissions every module declares into one invite-URL integer.
 * PLAN.md §10.3: compute this from manifests, never by hand.
 */
export function combinePermissions(required: Iterable<bigint>): bigint {
  let acc = 0n;
  for (const bit of required) acc |= bit;
  return acc;
}
