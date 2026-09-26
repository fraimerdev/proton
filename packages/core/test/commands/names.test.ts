import { describe, expect, test } from 'bun:test';
import {
  type CommandNameEntry,
  commandLabel,
  nameClash,
  resolveCommandNames,
} from '../../src/commands/names.ts';

function entry(
  key: string,
  customName: string | null = null,
  updatedAt: string | null = null,
  kind: CommandNameEntry['kind'] = 'chat',
): CommandNameEntry {
  return { key, kind, defaultName: key, customName, updatedAt };
}

const EARLY = '2026-09-01T10:00:00.000Z';
const LATE = '2026-09-10T10:00:00.000Z';

describe('resolveCommandNames', () => {
  test('every command keeps its default name when nothing is customized', () => {
    expect(resolveCommandNames([entry('ban'), entry('kick')])).toEqual({
      names: { ban: 'ban', kick: 'kick' },
      ignored: {},
    });
  });

  test('a custom name is used when nothing else holds it', () => {
    expect(resolveCommandNames([entry('ban', 'punish', EARLY), entry('kick')]).names).toEqual({
      ban: 'punish',
      kick: 'kick',
    });
  });

  test('a blank custom name is the default', () => {
    expect(resolveCommandNames([entry('ban', '  ', EARLY)]).names).toEqual({ ban: 'ban' });
  });

  test('a command using its default name wins, and the other is told why it reverted', () => {
    const resolved = resolveCommandNames([entry('note'), entry('tag', 'note', EARLY)]);

    expect(resolved.names).toEqual({ note: 'note', tag: 'tag' });
    expect(resolved.ignored).toEqual({
      tag: 'Proton now has its own /note, so this command is back to /tag.',
    });
  });

  test('between two customized commands the one saved first wins', () => {
    const resolved = resolveCommandNames([
      entry('warn', 'strike', LATE),
      entry('kick', 'strike', EARLY),
    ]);

    expect(resolved.names).toEqual({ warn: 'warn', kick: 'strike' });
    expect(resolved.ignored).toEqual({
      warn: '/kick was renamed to /strike first, so this command is back to /warn.',
    });
  });

  test('saved at the same moment, the lower key wins', () => {
    const resolved = resolveCommandNames([
      entry('warn', 'strike', EARLY),
      entry('kick', 'strike', EARLY),
    ]);

    expect(resolved.names).toEqual({ warn: 'warn', kick: 'strike' });
  });

  test('a row with no save time loses to one that has one', () => {
    const resolved = resolveCommandNames([
      entry('kick', 'strike', null),
      entry('warn', 'strike', LATE),
    ]);

    expect(resolved.names).toEqual({ warn: 'strike', kick: 'kick' });
  });

  test('a reverted command reclaims its default name from whoever borrowed it', () => {
    const resolved = resolveCommandNames([
      entry('a', 'x', EARLY),
      entry('b', 'x', LATE),
      entry('c', 'b', EARLY),
    ]);

    expect(resolved.names).toEqual({ a: 'x', b: 'b', c: 'c' });
    expect(Object.keys(resolved.ignored).sort()).toEqual(['b', 'c']);
    expect(resolved.ignored.c).toBe('Proton now has its own /b, so this command is back to /c.');
  });

  test('a chain of reversions settles on a fixed point', () => {
    const resolved = resolveCommandNames([
      entry('a', 'z', EARLY),
      entry('b', 'z', LATE),
      entry('c', 'b', '2026-09-02T00:00:00.000Z'),
      entry('d', 'c', '2026-09-03T00:00:00.000Z'),
      entry('e', 'd', '2026-09-04T00:00:00.000Z'),
    ]);

    expect(resolved.names).toEqual({ a: 'z', b: 'b', c: 'c', d: 'd', e: 'e' });
    expect(Object.keys(resolved.ignored).sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  test('a swap is fine when each name is free once the other has moved', () => {
    expect(
      resolveCommandNames([entry('ban', 'kick', EARLY), entry('kick', 'ban', LATE)]).names,
    ).toEqual({ ban: 'kick', kick: 'ban' });
  });

  test('slash names compare exactly, menu names ignore case', () => {
    expect(resolveCommandNames([entry('ban'), entry('kick', 'Ban', EARLY)]).names).toEqual({
      ban: 'ban',
      kick: 'Ban',
    });

    const menus = resolveCommandNames([
      {
        key: 'user:Report user',
        kind: 'user',
        defaultName: 'Report user',
        customName: null,
        updatedAt: null,
      },
      {
        key: 'user:Warn user',
        kind: 'user',
        defaultName: 'Warn user',
        customName: 'report USER',
        updatedAt: EARLY,
      },
    ]);
    expect(menus.names['user:Warn user']).toBe('Warn user');
    expect(menus.ignored['user:Warn user']).toBe(
      'Proton now has its own “Report user”, so this command is back to “Warn user”.',
    );
  });

  test('the same name in different kinds is no clash', () => {
    const resolved = resolveCommandNames([
      entry('report'),
      {
        key: 'user:report',
        kind: 'user',
        defaultName: 'report',
        customName: null,
        updatedAt: null,
      },
      {
        key: 'message:Punish',
        kind: 'message',
        defaultName: 'Punish',
        customName: 'report',
        updatedAt: EARLY,
      },
    ]);

    expect(resolved.ignored).toEqual({});
    expect(resolved.names['message:Punish']).toBe('report');
  });
});

describe('nameClash', () => {
  const guild = [
    entry('ban'),
    entry('warn', 'kick', EARLY),
    entry('kick', 'boot', EARLY),
    entry('note'),
  ];

  test('names who already holds the name and what to do about it', () => {
    expect(nameClash(guild, 'ban', 'kick')).toBe(
      '/warn is already called “kick”. Rename /warn first.',
    );
  });

  test('a default name another command still uses is taken', () => {
    expect(nameClash(guild, 'ban', 'note')).toBe(
      'Proton already has a /note command. Pick another name.',
    );
  });

  test('a default name its command has moved away from is free', () => {
    expect(nameClash([entry('ban'), entry('kick', 'boot', EARLY)], 'ban', 'kick')).toBeNull();
  });

  test('keeping the name the command already holds is never a clash', () => {
    expect(nameClash(guild, 'warn', 'kick')).toBeNull();
  });

  test('going back to the default name is never blocked, because a default wins', () => {
    expect(nameClash(guild, 'kick', 'kick')).toBeNull();
    expect(nameClash(guild, 'kick', null)).toBeNull();
    expect(nameClash(guild, 'kick', '  ')).toBeNull();
  });

  test('a clash between two other commands never blocks this save', () => {
    const tangled = [entry('ban'), entry('warn', 'strike', EARLY), entry('kick', 'strike', LATE)];

    expect(nameClash(tangled, 'ban', 'punish')).toBeNull();
  });

  test('a menu clash ignores case and stays inside its kind', () => {
    const menus: CommandNameEntry[] = [
      {
        key: 'user:Report user',
        kind: 'user',
        defaultName: 'Report user',
        customName: null,
        updatedAt: null,
      },
      {
        key: 'user:Warn user',
        kind: 'user',
        defaultName: 'Warn user',
        customName: null,
        updatedAt: null,
      },
      { key: 'report', kind: 'chat', defaultName: 'report', customName: null, updatedAt: null },
    ];

    expect(nameClash(menus, 'user:Warn user', 'report USER')).toBe(
      'Proton already has a “Report user” command. Pick another name.',
    );
    expect(nameClash(menus, 'user:Warn user', 'report')).toBeNull();
  });

  test('an unknown command is not this function’s business', () => {
    expect(nameClash(guild, 'ghost', 'ban')).toBeNull();
  });
});

describe('commandLabel', () => {
  test('slash commands carry a slash, menus are quoted', () => {
    expect(commandLabel('chat', 'ban')).toBe('/ban');
    expect(commandLabel('user', 'Report user')).toBe('“Report user”');
    expect(commandLabel('message', 'Punish author')).toBe('“Punish author”');
  });
});
