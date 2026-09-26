import { describe, expect, test } from 'bun:test';
import { ROLE_GRANT_REFUSAL_CODES, roleGrantRefusal } from '../../src/guild-state/roles.ts';
import type { GuildState } from '../../src/guild-state/types.ts';

const GUILD = '900000000000000001';
const BOT_ROLE = '410000000000000005';
const BELOW = '410000000000000001';
const ABOVE = '410000000000000009';
const LEVEL = '410000000000000006';
const MANAGED = '410000000000000002';
const GONE = '410000000000000099';

function state(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guildId: GUILD,
    ownerId: '200000000000000001',
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
      [BELOW, { id: BELOW, permissions: 0n, position: 2 }],
      [MANAGED, { id: MANAGED, permissions: 0n, position: 1, managed: true }],
      [BOT_ROLE, { id: BOT_ROLE, permissions: 0n, position: 5, managed: true }],
      [ABOVE, { id: ABOVE, permissions: 0n, position: 9 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map(),
    updatedAt: 0,
    ...overrides,
  };
}

describe('roleGrantRefusal', () => {
  test('a role below Proton’s highest role can be given', () => {
    expect(roleGrantRefusal(state(), BELOW)).toBeNull();
  });

  test('@everyone is refused, since Discord grants it automatically', () => {
    expect(roleGrantRefusal(state(), GUILD)).toEqual({
      code: 'everyone',
      reason: 'it is @everyone, which Discord grants automatically.',
    });
  });

  test('a role the server no longer has is refused', () => {
    expect(roleGrantRefusal(state(), GONE)).toEqual({
      code: 'missing',
      reason: 'it no longer exists in this server.',
    });
  });

  test('a missing role’s reason ends with where to fix it, when the caller says', () => {
    expect(
      roleGrantRefusal(
        state(),
        GONE,
        'Remove it from Member roles or Bot roles on the Join Roles page in the Proton dashboard.',
      )?.reason,
    ).toBe(
      'it no longer exists in this server. Remove it from Member roles or Bot roles on the ' +
        'Join Roles page in the Proton dashboard.',
    );
  });

  test('a managed role is refused, even one below Proton', () => {
    expect(roleGrantRefusal(state(), MANAGED)).toEqual({
      code: 'managed',
      reason: 'it is managed by Discord or another integration, so nobody can assign it by hand.',
    });
  });

  test('a role above Proton’s highest role is refused, naming both positions and the fix', () => {
    const refusal = roleGrantRefusal(state(), ABOVE);

    expect(refusal?.code).toBe('above_proton');
    expect(refusal?.reason).toBe(
      "it sits at position 9, and Proton's highest role is at position 5. Discord only lets Proton assign roles below its own, so drag Proton's role above it in Server Settings → Roles.",
    );
  });

  test('a role at the same position as Proton’s highest is refused too', () => {
    const level = state({
      roles: new Map([
        [BOT_ROLE, { id: BOT_ROLE, permissions: 0n, position: 5 }],
        [LEVEL, { id: LEVEL, permissions: 0n, position: 5 }],
      ]),
    });

    expect(roleGrantRefusal(level, LEVEL)?.code).toBe('above_proton');
  });

  test('with no known bot roles every role counts as above Proton', () => {
    expect(roleGrantRefusal(state({ botRoleIds: [] }), BELOW)?.code).toBe('above_proton');
  });

  test('the codes are exactly the four a caller has to handle', () => {
    expect(ROLE_GRANT_REFUSAL_CODES).toEqual(['everyone', 'missing', 'managed', 'above_proton']);
  });
});
