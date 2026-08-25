import type { GiveawaysConfig } from './config.ts';
import { hasAny } from './entry.ts';
import type { Giveaway } from './store.ts';

export interface Actor {
  userId: string;
  roleIds?: readonly string[];
}

/**
 * Who may act on somebody else's giveaway. The Permissions module already decides who may run
 * `/giveaway` at all; this is the second, finer gate the top-level command grant cannot express —
 * it is per-subcommand and per-giveaway, so a host keeps control of their own without being handed
 * everybody else's.
 */
export function canManage(
  config: GiveawaysConfig,
  actor: Actor,
  giveaway: Giveaway | null,
): boolean {
  if (
    giveaway !== null &&
    (giveaway.hostId === actor.userId || giveaway.createdBy === actor.userId)
  )
    return true;

  return hasAny(actor.roleIds ?? null, config.managerRoleIds);
}

export function refuseManage(giveaway: Giveaway | null): string {
  return giveaway === null
    ? 'You need a giveaway manager role to do that here.'
    : `**${giveaway.title}** was set up by <@${giveaway.hostId}>. You need a giveaway manager ` +
        'role to change somebody else’s giveaway.';
}
