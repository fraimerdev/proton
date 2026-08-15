import { describe, expect, test } from 'bun:test';
import type { RolemenuMenu, RolemenuMode } from '../src/config.ts';
import { resolveRoleChanges } from '../src/resolve.ts';

const CHANNEL = '500000000000000001';
const RED = '410000000000000001';
const BLUE = '410000000000000002';
const GREEN = '410000000000000003';

function colours(mode: RolemenuMode): RolemenuMenu {
  return {
    id: 'colours',
    channelId: CHANNEL,
    kind: 'button',
    mode,
    bindings: [
      { key: 'red', roleId: RED },
      { key: 'blue', roleId: BLUE },
      { key: 'green', roleId: GREEN },
    ],
  };
}

function resolve(
  mode: RolemenuMode,
  intent: 'grant' | 'revoke' | 'toggle',
  currentRoleIds: readonly string[] | null,
  bindingKey = 'red',
) {
  return resolveRoleChanges({ menu: colours(mode), bindingKey, intent, currentRoleIds });
}

describe('a key that names no binding', () => {
  test('resolves to nothing at all, in every mode', () => {
    for (const mode of ['toggle', 'add-only', 'unique'] as const) {
      expect(resolve(mode, 'toggle', [], 'purple')).toBeNull();
    }
  });
});

describe('mode: toggle', () => {
  test('grants what the member does not hold', () => {
    expect(resolve('toggle', 'grant', [])).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('grants nothing twice', () => {
    expect(resolve('toggle', 'grant', [RED])).toEqual({ roleId: RED, add: [], remove: [] });
  });

  test('revokes what the member holds', () => {
    expect(resolve('toggle', 'revoke', [RED])).toEqual({ roleId: RED, add: [], remove: [RED] });
  });

  test('revokes nothing they do not have', () => {
    expect(resolve('toggle', 'revoke', [BLUE])).toEqual({ roleId: RED, add: [], remove: [] });
  });

  test('a press flips on when they do not have it', () => {
    expect(resolve('toggle', 'toggle', [BLUE])).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('a press flips off when they do', () => {
    expect(resolve('toggle', 'toggle', [RED, BLUE])).toEqual({
      roleId: RED,
      add: [],
      remove: [RED],
    });
  });

  test('leaves the rest of the menu alone', () => {
    expect(resolve('toggle', 'grant', [BLUE, GREEN])).toEqual({
      roleId: RED,
      add: [RED],
      remove: [],
    });
  });
});

describe('mode: add-only', () => {
  test('grants like any other mode', () => {
    expect(resolve('add-only', 'grant', [])).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('refuses to revoke, which is the entire point of the mode', () => {
    expect(resolve('add-only', 'revoke', [RED])).toEqual({ roleId: RED, add: [], remove: [] });
  });

  test('a press on a role they already hold does nothing rather than taking it back', () => {
    expect(resolve('add-only', 'toggle', [RED])).toEqual({ roleId: RED, add: [], remove: [] });
  });

  test('a press on a role they lack still grants it', () => {
    expect(resolve('add-only', 'toggle', [])).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('will not revoke even when the roles are unknown', () => {
    expect(resolve('add-only', 'revoke', null)).toEqual({ roleId: RED, add: [], remove: [] });
  });
});

describe('mode: unique', () => {
  test('grants the choice and drops the previous one', () => {
    expect(resolve('unique', 'grant', [BLUE])).toEqual({
      roleId: RED,
      add: [RED],
      remove: [BLUE],
    });
  });

  test('drops every other bound role the member holds', () => {
    expect(resolve('unique', 'grant', [BLUE, GREEN])).toEqual({
      roleId: RED,
      add: [RED],
      remove: [BLUE, GREEN],
    });
  });

  test('does not touch bound roles the member does not hold', () => {
    expect(resolve('unique', 'grant', [])).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('repairs a member who somehow holds two answers at once', () => {
    expect(resolve('unique', 'grant', [RED, GREEN])).toEqual({
      roleId: RED,
      add: [],
      remove: [GREEN],
    });
  });

  test('leaves roles outside the menu alone', () => {
    const outsider = '410000000000000099';

    expect(resolve('unique', 'grant', [outsider, BLUE])).toEqual({
      roleId: RED,
      add: [RED],
      remove: [BLUE],
    });
  });

  test('revoking takes off the one role and does not strip the rest', () => {
    expect(resolve('unique', 'revoke', [RED, BLUE])).toEqual({
      roleId: RED,
      add: [],
      remove: [RED],
    });
  });

  test('a press on the role they already hold puts it down', () => {
    expect(resolve('unique', 'toggle', [RED])).toEqual({ roleId: RED, add: [], remove: [RED] });
  });

  test('a press on a different colour swaps them', () => {
    expect(resolve('unique', 'toggle', [BLUE])).toEqual({
      roleId: RED,
      add: [RED],
      remove: [BLUE],
    });
  });

  test('never strips the role it is granting, even when two keys share it', () => {
    const menu: RolemenuMenu = {
      id: 'colours',
      channelId: CHANNEL,
      kind: 'button',
      mode: 'unique',
      bindings: [
        { key: 'red', roleId: RED },
        { key: 'crimson', roleId: RED },
        { key: 'blue', roleId: BLUE },
      ],
    };

    expect(
      resolveRoleChanges({ menu, bindingKey: 'red', intent: 'grant', currentRoleIds: [RED, BLUE] }),
    ).toEqual({ roleId: RED, add: [], remove: [BLUE] });
  });
});

describe('an unknown role set — MESSAGE_REACTION_REMOVE carries no member', () => {
  test('still revokes, because "they appear not to have it" is not knowledge', () => {
    expect(resolve('toggle', 'revoke', null)).toEqual({ roleId: RED, add: [], remove: [RED] });
  });

  test('still grants, because a redundant PUT is free and a missing role is not', () => {
    expect(resolve('toggle', 'grant', null)).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('a toggle with nothing known grants rather than strips', () => {
    expect(resolve('toggle', 'toggle', null)).toEqual({ roleId: RED, add: [RED], remove: [] });
  });

  test('unique strips every other bound role, since it cannot tell which they hold', () => {
    expect(resolve('unique', 'grant', null)).toEqual({
      roleId: RED,
      add: [RED],
      remove: [BLUE, GREEN],
    });
  });
});
