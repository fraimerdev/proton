import { describe, expect, test } from 'bun:test';
import { commandsPollInterval } from '../src/lib/command-sync.ts';
import {
  commandHints,
  commandLabel,
  filterGroups,
  groupCommands,
  isRenamed,
  noModulesOn,
  replyOverrides,
} from '../src/pages/commands/list.ts';
import { CATALOGUE, MODERATION_REPLY, viewOf } from './commands-views.ts';

const ALL = CATALOGUE.map((entry) => viewOf(entry.key));

describe('the command list', () => {
  test('groups every command under its module, in sidebar order', () => {
    const groups = groupCommands(ALL);
    const ids = groups.map((group) => group.id);

    expect(groups.flatMap((group) => group.commands)).toHaveLength(ALL.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.indexOf('verification')).toBeLessThan(ids.indexOf('moderation'));
    expect(ids.indexOf('moderation')).toBeLessThan(ids.indexOf('tickets'));
  });

  test('lists slash commands before Apps menu commands in a group', () => {
    const moderation = groupCommands(ALL).find((group) => group.id === 'moderation');
    const kinds = moderation?.commands.map((command) => command.kind) ?? [];

    expect(kinds.indexOf('user')).toBeGreaterThan(kinds.lastIndexOf('chat'));
    expect(moderation?.label).toBe('Moderation');
  });

  test('search matches the name members see, Proton’s own name and the module, never a description the row does not show', () => {
    const renamed = viewOf('ban', { settings: { name: 'bonk' } });
    const groups = groupCommands([renamed, viewOf('kick'), viewOf('ticket')]);
    const keys = (term: string) =>
      filterGroups(groups, { term, moduleId: undefined }).flatMap((group) =>
        group.commands.map((command) => command.key),
      );

    expect(keys('bonk')).toEqual(['ban']);
    expect(keys('/ban')).toEqual(['ban']);
    expect(keys('tickets')).toEqual(['ticket']);
    expect(keys('remove a member')).toEqual([]);
    expect(keys('')).toHaveLength(3);
  });

  test('the module filter keeps one group', () => {
    const groups = groupCommands(ALL);

    expect(filterGroups(groups, { term: '', moduleId: 'tags' }).map((group) => group.id)).toEqual([
      'tags',
    ]);
  });
});

describe('row copy', () => {
  test('slash commands read with their slash; menus by their name', () => {
    expect(commandLabel(viewOf('ban'))).toBe('/ban');
    expect(commandLabel(viewOf('user:Report user'))).toBe('Report user');
  });

  test('a rename says what the command was called', () => {
    const renamed = viewOf('ban', { settings: { name: 'bonk' } });

    expect(isRenamed(renamed)).toBe(true);
    expect(commandHints(renamed)).toEqual(['Renamed from /ban']);
    expect(commandHints(viewOf('ban'))).toEqual([]);
  });

  test('a command whose module is off says members cannot see it', () => {
    expect(commandHints(viewOf('ban', { moduleOn: false }))).toEqual([
      'Moderation is off, so members can’t see /ban.',
    ]);
  });

  test('/help says why it stays while Help is off, unless its own switch hides it', () => {
    expect(commandHints(viewOf('help', { moduleOn: false, alwaysRegistered: true }))).toEqual([
      '/help stays available while Help is off, so there’s always a way to find the dashboard.',
    ]);
    expect(
      commandHints(
        viewOf('help', { moduleOn: false, alwaysRegistered: true, settings: { enabled: false } }),
      ),
    ).toEqual([]);
  });

  test('a name Proton had to ignore leads with the reason', () => {
    const reason = 'Proton now has its own /note, so this command is back to /tag.';

    expect(
      commandHints(
        viewOf('tag', { settings: { name: 'note' }, effectiveName: 'tag', ignored: reason }),
      ),
    ).toEqual([reason]);
  });
});

describe('who can see a command', () => {
  test('the page notices when no module is on at all', () => {
    expect(noModulesOn(ALL)).toBe(false);
    expect(noModulesOn(ALL.map((command) => ({ ...command, moduleOn: false })))).toBe(true);
    expect(noModulesOn([])).toBe(false);
  });
});

describe('module pages list the commands whose reply is set on the Commands page', () => {
  test('only explicit preferences on commands that offer the control', () => {
    const commands = [
      viewOf('ban', { settings: { privateReply: false }, reply: MODERATION_REPLY }),
      viewOf('kick', { settings: { privateReply: true }, reply: MODERATION_REPLY }),
      viewOf('warn', { reply: MODERATION_REPLY }),
      viewOf('timeout', { settings: { privateReply: true } }),
      viewOf('tag', { settings: { privateReply: true }, reply: MODERATION_REPLY }),
    ];

    expect(replyOverrides(commands, 'moderation')).toEqual([
      '/ban replies publicly',
      '/kick replies privately',
    ]);
    expect(replyOverrides(commands, 'tags')).toEqual(['/tag replies privately']);
  });
});

describe('polling while Discord catches up', () => {
  test('every 3 seconds while pending, for two minutes', () => {
    expect(commandsPollInterval('pending', 0, 1_000)).toBe(3_000);
    expect(commandsPollInterval('pending', 0, 119_999)).toBe(3_000);
    expect(commandsPollInterval('pending', 0, 120_000)).toBe(false);
    expect(commandsPollInterval('synced', 0, 1_000)).toBe(false);
    expect(commandsPollInterval(undefined, 0, 1_000)).toBe(false);
  });
});
