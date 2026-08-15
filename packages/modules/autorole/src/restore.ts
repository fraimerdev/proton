import { type GuildState, highestRolePosition } from '@proton/core';

export interface RestorePlan {
  restore: string[];

  skipped: Array<{ roleId: string; reason: string }>;
}

export function planRestore(input: {
  state: GuildState | null;
  recordedRoleIds: readonly string[];

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

  restore.sort((a, b) => (state.roles.get(a)?.position ?? 0) - (state.roles.get(b)?.position ?? 0));

  return { restore, skipped };
}
