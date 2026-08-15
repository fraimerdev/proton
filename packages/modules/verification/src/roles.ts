import { type GuildState, highestRolePosition } from '@proton/core';
import type { QuarantineRecord } from './store.ts';

/** One move in a role swap, in the terms `ActionExecutor` understands. */
export interface RoleStep {
  kind: 'add_role' | 'remove_role';
  roleId: string;
  /** Names this step in a failure sentence: "granting the member role". */
  what: string;
}

export type RoleCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether Proton can put this role on somebody — checked *before* the executor
 * is called.
 *
 * This is I8's role-hierarchy rule applied to the role being granted rather than
 * to the member being acted on. `runPrechecks` compares the *target member's*
 * highest role against the bot's, which is the right check for a ban and the
 * wrong one here: a brand-new member holding nothing but `@everyone` passes it
 * comfortably, and the grant still fails because the role being handed out sits
 * above Proton. Discord is explicit — "a bot can grant roles to other users that
 * are of a lower position than its own highest role" (docs.discord.com,
 * Permissions → Permission Hierarchy, verified August 2026) — and *lower* means
 * strictly lower, so equal positions fail too.
 *
 * Closing that gap properly means `PrecheckInput` carrying the granted role's
 * position for `add_role`/`remove_role`, which is core's job; it is recorded as a
 * blocker on `createVerificationModule`. Until then this check lives here, where
 * the alternative is a bare 403 from Discord that names neither the role nor the
 * fix.
 */
export function checkGrantable(state: GuildState | null, roleId: string, label: string): RoleCheck {
  if (!state) {
    return {
      ok: false,
      reason:
        "I don't have this server's role list yet, so I can't tell whether I'm allowed to " +
        `move the ${label} role. Try again shortly.`,
    };
  }

  // `@everyone` is every member's by definition and Discord rejects both calls.
  if (roleId === state.everyoneRoleId) {
    return {
      ok: false,
      reason:
        `The ${label} role is set to @everyone, which Discord does not let anyone add or ` +
        'remove. Pick a real role in the Proton dashboard.',
    };
  }

  const role = state.roles.get(roleId);
  if (!role) {
    return {
      ok: false,
      reason:
        `The ${label} role (id ${roleId}) doesn't exist in this server any more, or I can't ` +
        'see it. Choose a role that exists in the Proton dashboard.',
    };
  }

  const botPosition = highestRolePosition(state.roles, state.botRoleIds);
  if (role.position >= botPosition) {
    return {
      ok: false,
      reason:
        `I can't grant the ${label} role (id ${roleId}): it sits at position ${role.position} ` +
        `and my own highest role is at position ${botPosition}. Discord only lets me assign ` +
        "roles below my own. Drag Proton's role above it in Server Settings → Roles.",
    };
  }

  return { ok: true };
}

/** Role position, or 0 for a role the snapshot has never heard of. */
function positionOf(state: GuildState, roleId: string): number {
  return state.roles.get(roleId)?.position ?? 0;
}

export interface QuarantinePlan {
  /**
   * Exactly what will be taken away, highest position first — and therefore
   * exactly what `/unquarantine` must give back.
   */
  priorRoleIds: string[];
  steps: RoleStep[];
}

/**
 * Plan the swap: strip what they hold, then mark them quarantined.
 *
 * **Removals come first.** Discord unions the allows of every role a member
 * holds, so an explicit allow on a role they still have beats the quarantine
 * role's deny — the isolation only takes effect once the other roles are gone.
 * Highest position first for the same reason anti-nuke strips in that order: if
 * we are rate-limited partway through, the roles carrying the dangerous
 * permissions have already gone.
 *
 * `@everyone` is excluded because Discord refuses to remove it, and the
 * quarantine role itself is excluded because re-running `/quarantine` on someone
 * already quarantined must not record the quarantine role as one of their
 * "prior" roles — that is how a release ends up handing the isolation role back.
 */
export function planQuarantine(input: {
  state: GuildState;
  memberRoleIds: readonly string[];
  quarantineRoleId: string;
}): QuarantinePlan {
  const { state, memberRoleIds, quarantineRoleId } = input;

  const priorRoleIds = [
    ...new Set(
      memberRoleIds.filter(
        (roleId) => roleId !== state.everyoneRoleId && roleId !== quarantineRoleId,
      ),
    ),
  ].sort((a, b) => positionOf(state, b) - positionOf(state, a));

  return {
    priorRoleIds,
    steps: [
      ...priorRoleIds.map(
        (roleId): RoleStep => ({ kind: 'remove_role', roleId, what: `removing role ${roleId}` }),
      ),
      {
        kind: 'add_role',
        roleId: quarantineRoleId,
        what: 'applying the quarantine role',
      },
    ],
  };
}

export interface ReleasePlan {
  steps: RoleStep[];
  /** Recorded roles that have since been deleted from the server. */
  vanishedRoleIds: string[];
  /** Recorded roles that have since moved above Proton's own highest role. */
  ungrantableRoleIds: string[];
}

/**
 * Plan the restoration.
 *
 * **The quarantine role comes off last.** If the run is interrupted, a member
 * holding their roles *and* a redundant quarantine role is recoverable — the
 * record is still there and `/unquarantine` can be run again. The reverse ordering
 * fails the other way: the isolation marker gone while the member still has
 * nothing, which reads to every moderator as "released" and to the member as
 * being locked out.
 *
 * Roles that no longer exist, or that have moved above Proton since the
 * quarantine, are reported rather than attempted. Discord would answer the first
 * with a 404 and the second with a 403, and neither names the role — "restored 4
 * of 7, and here are the 3" is the answer a moderator can act on (§15: the value
 * is restore *quality*).
 */
export function planRelease(input: {
  state: GuildState;
  record: QuarantineRecord;
  quarantineRoleId: string;
}): ReleasePlan {
  const { state, record, quarantineRoleId } = input;

  const vanishedRoleIds: string[] = [];
  const ungrantableRoleIds: string[] = [];
  const restorable: string[] = [];

  for (const roleId of record.priorRoleIds) {
    const check = checkGrantable(state, roleId, 'recorded');
    if (check.ok) {
      restorable.push(roleId);
    } else if (state.roles.has(roleId)) {
      ungrantableRoleIds.push(roleId);
    } else {
      vanishedRoleIds.push(roleId);
    }
  }

  return {
    steps: [
      ...restorable.map(
        (roleId): RoleStep => ({ kind: 'add_role', roleId, what: `restoring role ${roleId}` }),
      ),
      {
        kind: 'remove_role',
        roleId: quarantineRoleId,
        what: 'removing the quarantine role',
      },
    ],
    vanishedRoleIds,
    ungrantableRoleIds,
  };
}
