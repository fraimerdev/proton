import { describe, expect, test } from 'bun:test';
import type { ModuleSummary } from '@proton/core';
import {
  buildGroups,
  displayNamesOf,
  filterGroups,
  foldRetired,
  refusalSentence,
  rowHint,
} from '../src/pages/permissions/commands.ts';
import { viewOf } from './commands-views.ts';

const MODULES = [
  { id: 'moderation', name: 'Moderation', category: 'moderation', commands: ['ban', 'kick'] },
] as unknown as ModuleSummary[];

const NAMES = displayNamesOf([
  viewOf('ban', { settings: { name: 'bonk' } }),
  viewOf('kick'),
  viewOf('user:Report user'),
]);

describe('the Permissions page names commands as members see them', () => {
  test('only slash commands are mapped, keyed by their internal key', () => {
    expect([...NAMES.entries()]).toEqual([
      ['ban', 'bonk'],
      ['kick', 'kick'],
    ]);
    expect(displayNamesOf(undefined).size).toBe(0);
  });

  test('rows keep the key for overrides and show the effective name', () => {
    const rows = buildGroups(MODULES, foldRetired({ ban: ['1'] }), NAMES)[0]?.rows ?? [];
    const ban = rows.find((row) => row.name === 'ban');

    expect(ban?.displayName).toBe('bonk');
    expect(ban?.roles).toEqual(['1']);
    expect(rows.find((row) => row.name === 'kick')?.displayName).toBe('kick');
  });

  test('without the catalogue the key stands in', () => {
    const rows = buildGroups(MODULES, foldRetired({}))[0]?.rows ?? [];

    expect(rows.map((row) => row.displayName)).toEqual(['ban', 'kick']);
  });

  test('search finds a renamed command by either name', () => {
    const groups = buildGroups(MODULES, foldRetired({}), NAMES);
    const found = (term: string) =>
      filterGroups(groups, { term, show: 'all', moduleId: undefined }).flatMap((group) =>
        group.rows.map((row) => row.name),
      );

    expect(found('bonk')).toEqual(['ban']);
    expect(found('ban')).toEqual(['ban']);
    expect(found('/bonk')).toEqual(['ban']);
  });

  test('a renamed row says what it was called, beside its override state', () => {
    const [ban, kick] = buildGroups(MODULES, foldRetired({ ban: ['1'] }), NAMES)[0]?.rows ?? [];
    if (!ban || !kick) throw new Error('expected two rows');

    expect(rowHint(ban)).toBe('Renamed from /ban');
    expect(rowHint(kick)).toBe('No override. Discord’s own command permissions apply.');
    expect(rowHint({ ...kick, displayName: 'boot' })).toBe(
      'Renamed from /kick · No override. Discord’s own command permissions apply.',
    );
  });

  test('the refusal preview uses the name members typed', () => {
    expect(refusalSentence('bonk', ['1'], () => 'Mods')).toContain(
      'to use /bonk in this server. This is a Proton command override',
    );
  });
});
