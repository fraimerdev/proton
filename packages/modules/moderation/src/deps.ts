import type { GuildStateStore } from '@proton/core';
import type { GuildMemberLister } from './members.ts';
import type { RoleRunStore } from './run-store.ts';
import type { WarningStore } from './store.ts';

export interface ModerationDeps {
  // Unbound leaves the subcommand that needs it registered but refusing: the command list is
  // built without bindings for the dashboard and the landing page, and a command that vanishes
  // there is worse than one that says why it cannot run.
  warnings?: WarningStore;

  // Role positions and the managed flag, for the hierarchy checks the executor's prechecks do not
  // make — they judge the target member, never the role being handed out or the invoker's rank.
  guildState?: GuildStateStore;

  // The target member's own roles, for the same reason: ranking them against the invoker needs
  // their role list, and the executor fetches it too late and only ever compares it to Proton's.
  fetchMemberRoles?(guildId: string, userId: string): Promise<string[] | null>;

  members?: GuildMemberLister;
  roleRuns?: RoleRunStore;

  // Needed to follow up a deferred interaction: /role's mass path answers after it has posted a
  // message and booked a job, which is well past the three seconds Discord allows a first reply.
  applicationId?: string;
}
