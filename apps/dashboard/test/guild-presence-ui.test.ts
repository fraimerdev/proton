import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function source(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8');
}

const PICKER = source('routes', 'dashboard', 'index.tsx');
const SHELL = source('components', 'shell', 'app-shell.tsx');
const STYLES = source('styles.css');

/**
 * A server Proton is not in is greyed out by an attribute the component writes and a selector the
 * stylesheet matches. Nothing type-checks that pair, and the failure is silent: the flag keeps
 * flowing, the rows keep rendering, and every server just looks joined.
 */
describe('the not-in-this-server treatment', () => {
  test('both guild lists mark the rows Proton is absent from', () => {
    expect(PICKER).toContain(`data-present={guild.present ? undefined : 'false'}`);
    expect(SHELL).toContain(`data-present={candidate.present ? undefined : 'false'}`);
  });

  test('the stylesheet greys out exactly what those components mark', () => {
    expect(STYLES).toContain('.guild-row[data-present="false"]');
    expect(STYLES).toContain('.rail-guild[data-present="false"]');
  });

  test('the picker says why a row is grey, rather than only dimming it', () => {
    expect(PICKER).toContain('Proton is not in this server');
  });

  test('the rail, which is icons only, says so where a screen reader can reach it', () => {
    expect(SHELL).toMatch(/aria-label=\{[\s\S]*?Proton is not in this server/);
  });

  // Dimming the line that explains the dimming leaves a grey row saying nothing.
  test('the reason line is not dimmed with the rest of the row', () => {
    expect(STYLES).not.toContain('.guild-row[data-present="false"] .guild-row-role');
  });
});
