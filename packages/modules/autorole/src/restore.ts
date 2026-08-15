import { type GuildState, highestRolePosition } from '@proton/core';

export interface RestorePlan {
  /** Roles that will be handed back, in ascending position order. */
  restore: string[];
  /**
   * Roles that were recorded but will not be restored, each with a sentence
   * naming why. Reported rather than dropped: "restored 4 of 7, and here are the
   * 3" is the answer a moderator can act on, and silence here looks identical to
   * the feature not working.
   */
  skipped: Array<{ roleId: string; reason: string }>;
}

/**
 * Decide what a returning member gets back.
 *
 * Pure, so every rule below is testable without Discord, Postgres or a clock —
 * and this is a function where the rules matter more than the plumbing, because
 * every one of them is a way to hand somebody a permission they should not have.
 *
 * Four roles are refused, and none of the refusals is cosmetic:
 *
 *  - **`@everyone`.** Every member has it by definition and Discord rejects both
 *    adding and removing it.
 *  - **Managed roles.** Discord owns these — booster roles, integration roles,
 *    another bot's role. `PUT /guilds/{g}/members/{u}/roles/{r}` answers 403 for
 *    them no matter how the hierarchy sits, so attempting one spends a rate-limit
 *    token to be told no.
 *  - **Roles at or above Proton's own highest.** Discord only permits assigning
 *    roles *strictly* below the bot's top role, so an equal position fails too —
 *    the off-by-one that reads as "it works for most roles and mysteriously not
 *    for the important one".
 *  - **Roles the guild did not put on the allowlist**, when it set one. This is
 *    the check that stops a kicked moderator being handed their moderator role
 *    back by simply rejoining, which is the single most dangerous thing this
 *    feature could do.
 */
export function planRestore(input: {
  state: GuildState | null;
  recordedRoleIds: readonly string[];
  /** Empty means "every role is eligible". */
  allowlist: readonly string[];
}): RestorePlan {
  const { state, recordedRoleIds, allowlist } = input;

  if (!state) {
    return {
      restore: [],
      skipped: recordedRoleIds.map((roleId) => ({
        roleId,
        reason:
          "I don't have this server's role list yet, so I can't tell which roles I'm allowed " +
          'to restore. They were left alone rather than guessed at.',
      })),
    };
  }

  const permitted = new Set(allowlist);
  const botPosition = highestRolePosition(state.roles, state.botRoleIds);

  const restore: string[] = [];
  const skipped: RestorePlan['skipped'] = [];

  for (const roleId of new Set(recordedRoleIds)) {
    if (roleId === state.everyoneRoleId) {
      skipped.push({ roleId, reason: 'it is @everyone, which Discord grants automatically.' });
      continue;
    }

    if (permitted.size > 0 && !permitted.has(roleId)) {
      skipped.push({
        roleId,
        reason:
          'it is not on this server’s list of roles eligible for restoring. Add it in the ' +
          'Proton dashboard if it should come back.',
      });
      continue;
    }

    const role = state.roles.get(roleId);
    if (!role) {
      skipped.push({ roleId, reason: 'it no longer exists in this server.' });
      continue;
    }

    if (role.managed) {
      skipped.push({
        roleId,
        reason: 'it is managed by Discord or another integration, so nobody can assign it by hand.',
      });
      continue;
    }

    if (role.position >= botPosition) {
      skipped.push({
        roleId,
        reason:
          `it sits at position ${role.position} and my own highest role is at position ` +
          `${botPosition}. Discord only lets me assign roles below my own — drag Proton's ` +
          'role above it in Server Settings → Roles.',
      });
      continue;
    }

    restore.push(roleId);
  }

  /**
   * Ascending position, so the least privileged role is granted first.
   *
   * Each grant is its own REST call and the run can be interrupted by a rate
   * limit or a restart. Interrupted halfway, this ordering leaves the member
   * holding the *least* powerful subset of what they had, which is the safe
   * direction to fail in.
   */
  restore.sort((a, b) => (state.roles.get(a)?.position ?? 0) - (state.roles.get(b)?.position ?? 0));

  return { restore, skipped };
}
