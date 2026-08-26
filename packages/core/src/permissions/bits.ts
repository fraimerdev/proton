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

// Discord's own client labels several permissions differently from their API names — its docs name
// three outright. An admin told to grant "ManageGuild" or "ModerateMembers" will search Server
// Settings → Roles for a switch that is not spelled that way anywhere in Discord.
const PERMISSION_LABELS: Partial<Record<PermissionName, string>> = {
  ManageGuild: 'Manage Server',
  ModerateMembers: 'Timeout Members',
  SendPolls: 'Create Polls',
  UseVAD: 'Use Voice Activity',
  SendMessagesInThreads: 'Send Messages in Threads',
  SendTTSMessages: 'Send Text-To-Speech Messages',
  UseExternalEmojis: 'Use External Emoji',
  ViewGuildInsights: 'View Server Insights',
  Stream: 'Video',
  CreateInstantInvite: 'Create Invite',
  ManageGuildExpressions: 'Manage Expressions',
  CreateGuildExpressions: 'Create Expressions',
  UseEmbeddedActivities: 'Use Activities',
};

export function permissionLabel(name: PermissionName): string {
  return PERMISSION_LABELS[name] ?? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function permissionLabels(permissions: bigint): string[] {
  return permissionNames(permissions).map(permissionLabel);
}

export function combinePermissions(required: Iterable<bigint>): bigint {
  let acc = 0n;
  for (const bit of required) acc |= bit;
  return acc;
}
