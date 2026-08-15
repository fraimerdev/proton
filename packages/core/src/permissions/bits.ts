import { PermissionFlagsBits } from 'discord-api-types/v10';

export const Permissions = PermissionFlagsBits;

export type PermissionName = keyof typeof PermissionFlagsBits;

export const ALL_PERMISSIONS: bigint = Object.values(PermissionFlagsBits).reduce(
  (acc, bit) => acc | bit,
  0n,
);

export const NO_PERMISSIONS = 0n;

export const TIMEOUT_ALLOWED_PERMISSIONS: bigint =
  PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

export function has(permissions: bigint, required: bigint): boolean {
  return (permissions & required) === required;
}

export function hasWithAdmin(permissions: bigint, required: bigint): boolean {
  if ((permissions & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) {
    return true;
  }
  return has(permissions, required);
}

export function missing(permissions: bigint, required: bigint): bigint {
  return required & ~permissions;
}

export function permissionNames(permissions: bigint): PermissionName[] {
  const names: PermissionName[] = [];
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
    if ((permissions & bit) === bit && bit !== 0n) names.push(name as PermissionName);
  }
  return names;
}

export function combinePermissions(required: Iterable<bigint>): bigint {
  let acc = 0n;
  for (const bit of required) acc |= bit;
  return acc;
}
