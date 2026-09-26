import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { preflightSync } from '../src/sync/preflight.ts';
import {
  BOT_ROLE,
  GUILD,
  PROTON,
  ROLE_ABOVE_BOT,
  ROLE_GONE,
  ROLE_LOW,
  ROLE_MANAGED,
  ROLE_MID,
} from './harness.ts';
import { syncState } from './sync-harness.ts';

describe('preflightSync', () => {
  test('a missing Manage Roles is named, with where to turn it on', () => {
    const result = preflightSync(
      syncState(Permissions.SendMessages),
      { memberRoleIds: [ROLE_LOW], botRoleIds: [] },
      PROTON,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('missing_permission');
    expect(result.failure.message).toContain('Manage Roles');
    expect(result.failure.message).toContain('Server Settings → Roles');
  });

  test('Administrator is enough on its own', () => {
    const result = preflightSync(
      syncState(Permissions.Administrator),
      { memberRoleIds: [ROLE_LOW], botRoleIds: [] },
      PROTON,
    );

    expect(result.ok).toBe(true);
  });

  test('fails when none of the roles can be given, naming each one', () => {
    const result = preflightSync(
      syncState(),
      { memberRoleIds: [ROLE_ABOVE_BOT, ROLE_MANAGED], botRoleIds: [ROLE_GONE, GUILD] },
      PROTON,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('roles_blocked');
    expect(result.blockedRoles).toEqual([
      { roleId: ROLE_ABOVE_BOT, code: 'above_proton' },
      { roleId: ROLE_MANAGED, code: 'managed' },
      { roleId: ROLE_GONE, code: 'missing' },
      { roleId: GUILD, code: 'everyone' },
    ]);
  });

  test('carries on when only some are blocked, recording which', () => {
    const result = preflightSync(
      syncState(),
      { memberRoleIds: [ROLE_MID, ROLE_ABOVE_BOT, ROLE_LOW], botRoleIds: [BOT_ROLE] },
      PROTON,
    );

    expect(result).toEqual({
      ok: true,
      memberRoleIds: [ROLE_LOW, ROLE_MID],
      botRoleIds: [],
      blockedRoles: [
        { roleId: ROLE_ABOVE_BOT, code: 'above_proton' },
        { roleId: BOT_ROLE, code: 'above_proton' },
      ],
    });
  });

  test('with no roles set there is nothing to sync', () => {
    const result = preflightSync(syncState(), { memberRoleIds: [], botRoleIds: [] }, PROTON);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('nothing_to_sync');
  });
});
