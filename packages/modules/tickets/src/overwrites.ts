import { type PermissionOverwriteSpec, Permissions } from '@proton/core';

export const OVERWRITE_ROLE = 0;
export const OVERWRITE_MEMBER = 1;

export const TICKET_MEMBER_ALLOW =
  Permissions.ViewChannel |
  Permissions.SendMessages |
  Permissions.ReadMessageHistory |
  Permissions.AttachFiles |
  Permissions.EmbedLinks;

// What a member keeps while the ticket is locked: they can still read the conversation and the
// staff answer, which is the difference between locking a ticket and closing it.
export const TICKET_LOCKED_ALLOW =
  Permissions.ViewChannel | Permissions.ReadMessageHistory | Permissions.EmbedLinks;

export const TICKET_LOCKED_DENY = Permissions.SendMessages | Permissions.AttachFiles;

// Identical to TICKET_MEMBER_ALLOW on purpose. Discord refuses to let a bot grant a permission it
// does not itself hold, so every bit added here becomes a bit the bot must have before it may
// create any ticket channel at all. Staff who need Manage Messages already have it from their roles.
export const TICKET_STAFF_ALLOW = TICKET_MEMBER_ALLOW;

export interface OverwriteInput {
  guildId: string;

  ownerId: string;

  staffRoleIds: readonly string[];

  botUserId?: string | undefined;

  participantIds?: readonly string[];

  locked?: boolean;
}

export function memberOverwrite(userId: string, locked = false): PermissionOverwriteSpec {
  return locked
    ? {
        id: userId,
        type: OVERWRITE_MEMBER,
        allow: TICKET_LOCKED_ALLOW.toString(),
        deny: TICKET_LOCKED_DENY.toString(),
      }
    : { id: userId, type: OVERWRITE_MEMBER, allow: TICKET_MEMBER_ALLOW.toString(), deny: '0' };
}

// Built for the create call, not patched on afterwards: a ticket channel that exists for even one
// round trip without the @everyone deny is a support conversation the whole server can read.
export function ticketOverwrites(input: OverwriteInput): PermissionOverwriteSpec[] {
  const overwrites: PermissionOverwriteSpec[] = [
    { id: input.guildId, type: OVERWRITE_ROLE, deny: Permissions.ViewChannel.toString() },
  ];

  const staff = new Set(input.staffRoleIds);

  const members = new Set<string>([input.ownerId, ...(input.participantIds ?? [])]);

  for (const id of members) {
    // The bot is never silenced by a lock, even when somebody added it to the ticket as a member:
    // it still has to post the closing message and answer the controls in a locked channel.
    overwrites.push(memberOverwrite(id, input.locked === true && id !== input.botUserId));
  }

  // Only ViewChannel and friends: Manage Channels and Manage Roles reach the channel from the
  // bot's guild-level permissions already, and granting them here would make the bot need them
  // before it could create the channel that grants them.
  if (input.botUserId !== undefined && !members.has(input.botUserId)) {
    overwrites.push(memberOverwrite(input.botUserId));
  }

  for (const roleId of staff) {
    if (roleId === input.guildId) continue;

    overwrites.push({ id: roleId, type: OVERWRITE_ROLE, allow: TICKET_STAFF_ALLOW.toString() });
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

  return [...overwrites, memberOverwrite(userId)];
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

// Merged, never replaced: the live list carries whoever was let in since, and the required list
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
