import { describe, expect, test } from 'bun:test';
import { formatCommandLabel, labelOf } from '../../src/index.ts';

describe('formatCommandLabel', () => {
  test('a slash command is its name after a slash', () => {
    expect(formatCommandLabel('ping')).toBe('/ping');
    expect(formatCommandLabel('ping', '')).toBe('/ping');
  });

  test('a subcommand path is spelled the way a member types it', () => {
    expect(formatCommandLabel('lockdown', 'remove')).toBe('/lockdown remove');
    expect(formatCommandLabel('ticket', 'blacklist.add')).toBe('/ticket blacklist add');
  });

  test('the name the server gave the command replaces the key, never the path', () => {
    expect(formatCommandLabel('giveaway', 'reroll', 'gw')).toBe('/gw reroll');
    expect(formatCommandLabel('ticket', 'blacklist.add', 'support')).toBe('/support blacklist add');
  });

  test('a context menu is named the way Discord shows it, and takes no path', () => {
    expect(formatCommandLabel('user:Report user')).toBe('Apps → Report user');
    expect(formatCommandLabel('message:Punish author', 'ignored')).toBe('Apps → Punish author');
  });
});

describe('labelOf', () => {
  test('asks the context how this server shows the command', () => {
    const asked: Array<[string, string | undefined]> = [];
    const ctx = {
      commandLabel(key: string, path?: string) {
        asked.push([key, path]);
        return key === 'giveaway'
          ? formatCommandLabel(key, path, 'gw')
          : formatCommandLabel(key, path);
      },
    };

    expect(labelOf(ctx, 'giveaway', 'reroll')).toBe('/gw reroll');
    expect(labelOf(ctx, 'lockdown', 'remove')).toBe('/lockdown remove');
    expect(asked).toEqual([
      ['giveaway', 'reroll'],
      ['lockdown', 'remove'],
    ]);
  });

  test('without a label source falls back to the internal name', () => {
    expect(labelOf({}, 'giveaway', 'reroll')).toBe('/giveaway reroll');
    expect(labelOf({}, 'ticket', 'blacklist.add')).toBe('/ticket blacklist add');
    expect(labelOf({}, 'ping')).toBe('/ping');
    expect(labelOf({}, 'user:Report user')).toBe('Apps → Report user');
  });
});
