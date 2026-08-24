import { type PermissionOverwriteSpec, Permissions } from '@proton/core';
import type { PrivacyMode } from './config.ts';
import type { AccessKind } from './table.ts';

export const ROLE_OVERWRITE = 0;
export const MEMBER_OVERWRITE = 1;

/** What a member needs to get into a voice channel and be heard. */
const JOIN = Permissions.ViewChannel | Permissions.Connect;

/**
 * Proton's own overwrite. It is written last and never negotiable: locking a channel by denying
 * @everyone Connect also denies it to the bot, and a bot that cannot connect cannot move the owner
 * back in, cannot enforce a later privacy change, and cannot recover the channel at all.
 */
const BOT_KEEPS =
  Permissions.ViewChannel |
  Permissions.Connect |
  Permissions.ManageChannels |
  Permissions.MoveMembers;

export interface AccessEntry {
  userId: string;
  kind: AccessKind;
}

export interface OverwritePlanInput {
  /** The @everyone role id, which Discord defines as the guild id. */
  guildId: string;
  botUserId: string;

  ownerId: string | null;
  privacy: PrivacyMode;

  access: readonly AccessEntry[];

  /** Copied from the category or the creator channel when permissionSync asks for it. */
  inherited?: readonly PermissionOverwriteSpec[] | undefined;
}

function bits(value: string | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

function key(entry: { id: string; type: number }): string {
  return `${entry.type}:${entry.id}`;
}

function merge(
  into: Map<string, { id: string; type: 0 | 1; allow: bigint; deny: bigint }>,
  id: string,
  type: 0 | 1,
  allow: bigint,
  deny: bigint,
): void {
  const at = key({ id, type });
  const existing = into.get(at) ?? { id, type, allow: 0n, deny: 0n };

  // Allow wins within one entry: granting a bit and denying it in the same overwrite is a
  // contradiction Discord resolves unpredictably, so it is resolved here instead.
  const nextAllow = (existing.allow | allow) & ~(deny & ~allow);
  const nextDeny = (existing.deny | deny) & ~nextAllow;

  into.set(at, { id, type, allow: nextAllow, deny: nextDeny });
}

/**
 * The whole overwrite set for a temporary channel, rebuilt from scratch every time rather than
 * patched. `edit_channel` replaces the array wholesale, so a partial write silently discards every
 * overwrite it does not mention — which is how a lock used to throw away the owner's own access.
 *
 * Applied in the order the spec fixes: inherited overwrites, then the privacy baseline, then the
 * owner, then trust and block, then Proton itself.
 */
export function planOverwrites(input: OverwritePlanInput): PermissionOverwriteSpec[] {
  const plan = new Map<string, { id: string; type: 0 | 1; allow: bigint; deny: bigint }>();

  for (const entry of input.inherited ?? []) {
    const type = entry.type === MEMBER_OVERWRITE ? MEMBER_OVERWRITE : ROLE_OVERWRITE;
    merge(plan, entry.id, type, bits(entry.allow), bits(entry.deny));
  }

  // @everyone. Public states nothing so the channel follows its category; the other two deny.
  if (input.privacy === 'locked') {
    merge(plan, input.guildId, ROLE_OVERWRITE, 0n, Permissions.Connect);
  } else if (input.privacy === 'private') {
    merge(plan, input.guildId, ROLE_OVERWRITE, 0n, JOIN);
  } else {
    const everyone = plan.get(key({ id: input.guildId, type: ROLE_OVERWRITE }));
    if (everyone) {
      // Public means Proton is not the one holding the door shut. An inherited deny stays.
      everyone.deny &= ~0n;
    }
  }

  if (input.ownerId !== null) {
    merge(plan, input.ownerId, MEMBER_OVERWRITE, JOIN, 0n);
  }

  for (const entry of input.access) {
    if (entry.kind === 'trust') merge(plan, entry.userId, MEMBER_OVERWRITE, JOIN, 0n);
    else merge(plan, entry.userId, MEMBER_OVERWRITE, 0n, JOIN);
  }

  merge(plan, input.botUserId, MEMBER_OVERWRITE, BOT_KEEPS, 0n);

  return [...plan.values()]
    .filter((entry) => entry.allow !== 0n || entry.deny !== 0n)
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      allow: entry.allow.toString(),
      deny: entry.deny.toString(),
    }));
}

/** Whether a member may currently connect, judged from the plan rather than from Discord. */
export function canJoin(
  plan: readonly PermissionOverwriteSpec[],
  guildId: string,
  userId: string,
): boolean {
  const mine = plan.find((entry) => entry.id === userId && entry.type === MEMBER_OVERWRITE);
  if (mine && (bits(mine.deny) & Permissions.Connect) !== 0n) return false;
  if (mine && (bits(mine.allow) & Permissions.Connect) !== 0n) return true;

  const everyone = plan.find((entry) => entry.id === guildId && entry.type === ROLE_OVERWRITE);
  return !everyone || (bits(everyone.deny) & Permissions.Connect) === 0n;
}

export function privacyOf(plan: readonly PermissionOverwriteSpec[], guildId: string): PrivacyMode {
  const everyone = plan.find((entry) => entry.id === guildId && entry.type === ROLE_OVERWRITE);
  const deny = bits(everyone?.deny);

  if ((deny & Permissions.ViewChannel) !== 0n) return 'private';
  if ((deny & Permissions.Connect) !== 0n) return 'locked';

  return 'public';
}
