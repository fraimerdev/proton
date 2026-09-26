import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogueFrom, PLACEHOLDER_MODULES } from '../src/lib/placeholder-catalogue.ts';

const MODULES = join(import.meta.dir, '..', '..', '..', 'packages', 'modules');

function modulesWithPlaceholders(): string[] {
  return readdirSync(MODULES)
    .filter((name) => {
      const manifest = join(MODULES, name, 'package.json');
      if (!existsSync(manifest)) return false;

      const { exports } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        exports?: Record<string, unknown>;
      };
      return exports !== undefined && './placeholders' in exports;
    })
    .sort();
}

describe('placeholder catalogue', () => {
  test('loads every module that ships placeholders', () => {
    expect(Object.keys(PLACEHOLDER_MODULES).sort()).toEqual(modulesWithPlaceholders());
  });

  test('says which messages a placeholder works in', async () => {
    const catalogue = catalogueFrom(
      await Promise.all(Object.values(PLACEHOLDER_MODULES).map((load) => load())),
    );

    expect(catalogue.whereKeyWorks('level.current')).toContain('Level-up announcement');
    expect(catalogue.whereKeyWorks('ticket.number')).toContain('Ticket opening message');
    expect(catalogue.whereKeyWorks('user.mention').length).toBeGreaterThan(3);
    expect(catalogue.whereKeyWorks('no.such.thing')).toEqual([]);
  });
});
