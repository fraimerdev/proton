import { type PermissionOverwriteSpec, Permissions } from '@proton/core';
import type { TicketPanel } from './config.ts';

export const OVERWRITE_ROLE = 0;
export const OVERWRITE_MEMBER = 1;

export const TICKET_MEMBER_ALLOW =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.ReadMessageHistory |
  Permissions.AttachFiles |
  Permissions.EmbedLinks;

export interface OverwriteInput {
  guildId: string;

  openerId: string;
  panel: TicketPanel;

  botUserId?: string | undefined;

  participantIds?: readonly string[];
}

// Built for the create call, not patched on afterwards: a ticket channel that exists for even one
// round trip without the @everyone deny is a support conversation the whole server can read.
export function ticketOverwrites(input: OverwriteInput): PermissionOverwriteSpec[] {
  const overwrites: PermissionOverwriteSpec[] = [
    { id: input.guildId, type: OVERWRITE_ROLE, deny: Permissions.ViewChannel.toString() },
  ];

  const allowed = new Set<string>([input.openerId, ...(input.participantIds ?? [])]);

  if (input.botUserId !== undefined) allowed.add(input.botUserId);

  for (const id of allowed) {
    overwrites.push({ id, type: OVERWRITE_MEMBER, allow: TICKET_MEMBER_ALLOW.toString() });
  }

  for (const roleId of input.panel.supportRoleIds) {
    if (roleId === input.guildId) continue;

    overwrites.push({ id: roleId, type: OVERWRITE_ROLE, allow: TICKET_MEMBER_ALLOW.toString() });
  }

  return overwrites;
}

export function withParticipant(
  overwrites: readonly PermissionOverwriteSpec[],
  userId: string,
): PermissionOverwriteSpec[] {
  if (overwrites.some((entry) => entry.id === userId && entry.type === OVERWRITE_MEMBER)) {
    return [...overwrites];
  }

  return [
    ...overwrites,
    { id: userId, type: OVERWRITE_MEMBER, allow: TICKET_MEMBER_ALLOW.toString() },
  ];
}

export function withoutParticipant(
  overwrites: readonly PermissionOverwriteSpec[],
  userId: string,
): PermissionOverwriteSpec[] {
  return overwrites.filter((entry) => !(entry.id === userId && entry.type === OVERWRITE_MEMBER));
}

export function fromGuildState(
  overwrites: ReadonlyArray<{ id: string; type: 0 | 1; allow: bigint; deny: bigint }>,
): PermissionOverwriteSpec[] {
  return overwrites.map((entry) => ({
    id: entry.id,
    type: entry.type,
    allow: entry.allow.toString(),
    deny: entry.deny.toString(),
  }));
}

// Merged, never replaced: the live list carries whoever /ticket add let in, and the panel list
// carries the @everyone deny that makes the channel private. Taking only the first would make a
// ticket public the moment the channel cache was empty or stale; taking only the second would
// silently revoke every added participant.
export function mergeOverwrites(
  live: readonly PermissionOverwriteSpec[],
  required: readonly PermissionOverwriteSpec[],
): PermissionOverwriteSpec[] {
  const key = (entry: PermissionOverwriteSpec): string => `${entry.type}:${entry.id}`;
  const enforced = new Map(required.map((entry) => [key(entry), entry]));

  const merged = live.map((entry) => enforced.get(key(entry)) ?? entry);
  const seen = new Set(merged.map(key));

  for (const entry of required) {
    if (!seen.has(key(entry))) merged.push(entry);
  }

  return merged;
}
