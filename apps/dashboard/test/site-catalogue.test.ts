import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging/config';
import { LOG_CATEGORIES, LOG_EVENT_KEYS } from '@proton/module-serverlog/catalogue';
import { collect, GENERATED_PATH, generate } from '../scripts/build-commands.ts';
import { CATEGORY_ORDER } from '../src/components/shell/module-meta.ts';
import {
  blurbFor,
  CATALOGUE,
  COMMAND_COUNT,
  catalogueByCategory,
  LOG_CATEGORY_COUNT,
  LOG_EVENT_COUNT,
  MODULE_COUNT,
  OAUTH_SCOPES,
  TOP_LEVEL_COMMANDS,
} from '../src/components/site/catalogue.ts';
import { COMMAND_SET, groupCommands, usageLine } from '../src/components/site/commands.ts';

const MODULES_DIR = join(import.meta.dir, '..', '..', '..', 'packages', 'modules');

/** Every module package that ships a manifest. `registry` is the thing that loads them. */
function moduleDirectories(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'registry')
    .map((entry) => entry.name)
    .sort();
}

describe('the public catalogue matches the modules that exist', () => {
  // A twenty-eighth module that nobody added here would be a module the marketing pages claim
  // Proton does not have, which is the one lie this page cannot afford.
  test('lists every module package, and no module that is not one', () => {
    expect(CATALOGUE.map((entry) => entry.id).sort()).toEqual(moduleDirectories());
  });

  test('files every module under a category the sidebar knows', () => {
    for (const entry of CATALOGUE) {
      expect(`${entry.id}: ${CATEGORY_ORDER.includes(entry.category)}`).toBe(`${entry.id}: true`);
    }
  });

  test('every entry carries real prose, not the category fallback', () => {
    for (const entry of CATALOGUE) {
      expect(`${entry.id}: ${blurbFor(entry)}`).not.toMatch(/: A \w+ module\.$/);
    }
  });

  test('grouping keeps every module exactly once, in sidebar order', () => {
    const groups = catalogueByCategory();

    expect(groups.map((group) => group.category)).toEqual(
      CATEGORY_ORDER.filter((category) => CATALOGUE.some((entry) => entry.category === category)),
    );
    expect(groups.flatMap((group) => group.entries).length).toBe(CATALOGUE.length);
  });

  test('MODULE_COUNT is the length of the list the page renders', () => {
    expect(MODULE_COUNT).toBe(CATALOGUE.length);
  });
});

describe('every command the catalogue prints is one a module registers', () => {
  test.each(
    CATALOGUE.flatMap((entry) => entry.commands.map((command) => [entry.id, command] as const)),
  )('%s registers %s', (moduleId, command) => {
    const registered = COMMAND_SET.some(
      (entry) =>
        entry.module === moduleId &&
        (entry.usage === command || entry.usage.startsWith(`${command} `)),
    );

    expect(`${command} in ${moduleId}: ${registered}`).toBe(`${command} in ${moduleId}: true`);
  });

  test('and every command a module registers is filed under a module the catalogue prints', () => {
    const named = new Set(
      CATALOGUE.flatMap((entry) => entry.commands.map((command) => `${entry.id}${command}`)),
    );

    for (const entry of COMMAND_SET) {
      const top = entry.usage.split(' ')[0] ?? '';

      expect(`${entry.usage} is claimed: ${named.has(`${entry.module}${top}`)}`).toBe(
        `${entry.usage} is claimed: true`,
      );
    }
  });

  test('the marquee draws from the same list', () => {
    expect(TOP_LEVEL_COMMANDS).toEqual(CATALOGUE.flatMap((entry) => entry.commands));
  });
});

describe('the counts the pages print in mono', () => {
  // Copied into catalogue.ts so a page that prints one integer does not ship the table it came
  // from. Copies go stale; this is what notices.
  test('match the serverlog catalogue they were taken from', () => {
    expect(LOG_EVENT_COUNT).toBe(LOG_EVENT_KEYS.length);
    expect(LOG_CATEGORY_COUNT).toBe(LOG_CATEGORIES.length);
  });

  test('match the generated command set', () => {
    expect(COMMAND_COUNT).toBe(COMMAND_SET.length);
  });

  test('the retention window is the one the logging module enforces', () => {
    expect(MESSAGE_LOG_RETENTION_DAYS).toBe(30);
  });

  test('the scopes are the ones better-auth actually asks Discord for', () => {
    const auth = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'auth.ts'), 'utf8');
    const declared = /scope:\s*\[([^\]]+)\]/.exec(auth)?.[1] ?? '';

    expect(declared.match(/'([^']+)'/g)?.map((raw) => raw.slice(1, -1))).toEqual([...OAUTH_SCOPES]);
  });
});

describe('the generated command set', () => {
  test('is what the generator produces from the current manifests', () => {
    expect(generate()).toBe(readFileSync(GENERATED_PATH, 'utf8'));
  });

  test('holds only commands a person can actually type', () => {
    for (const command of COMMAND_SET) {
      expect(`${command.usage} starts with a slash`).toBe(
        `${command.usage.startsWith('/') ? command.usage : `!${command.usage}`} starts with a slash`,
      );
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test('names a module the catalogue lists, for every command', () => {
    const ids = new Set(CATALOGUE.map((entry) => entry.id));

    for (const command of collect()) {
      expect(`${command.usage} -> ${ids.has(command.module)}`).toBe(`${command.usage} -> true`);
    }
  });

  test('writes required arguments in angle brackets and optional ones in square', () => {
    const ban = COMMAND_SET.find((command) => command.usage === '/ban add');

    expect(ban && usageLine(ban)).toBe('/ban add <user> [duration] [delete_message_days] [reason]');
  });
});

describe('searching the commands page', () => {
  test('finds a command by its name without the slash', () => {
    const found = groupCommands('timeout', 'all').flatMap((group) => group.commands);

    expect(found.map((command) => command.usage)).toContain('/timeout');
  });

  test('finds one by the words in its description', () => {
    const found = groupCommands('snapshot', 'all').flatMap((group) => group.commands);

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((command) => command.module === 'backup')).toBe(true);
  });

  test('a leading slash is ignored, because that is how people type a command', () => {
    expect(groupCommands('/ban', 'all')).toEqual(groupCommands('ban', 'all'));
  });

  test('the category filter narrows to that category and nothing else', () => {
    const groups = groupCommands('', 'moderation');

    expect(groups.every((group) => group.module.category === 'moderation')).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
  });

  test('an empty query shows every command', () => {
    const shown = groupCommands('', 'all').reduce(
      (total, group) => total + group.commands.length,
      0,
    );

    expect(shown).toBe(COMMAND_SET.length);
  });

  test('a query nothing matches returns no groups rather than empty ones', () => {
    expect(groupCommands('zzzznothing', 'all')).toEqual([]);
  });
});
