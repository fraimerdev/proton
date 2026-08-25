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
    expect(STYLES).toContain('.server-card[data-present="false"]');
    expect(STYLES).toContain('.rail-guild[data-present="false"]');
  });

  // The card is a picture with a button under it, so "Invite" instead of "Manage" is the only thing
  // on screen carrying this — and on its own it is a label, not a reason.
  test('the picker says why a card is grey, rather than only draining its colour', () => {
    expect(PICKER).toContain('Proton is not in this server');
  });

  test('the rail, which is icons only, says so where a screen reader can reach it', () => {
    expect(SHELL).toMatch(/aria-label=\{[\s\S]*?Proton is not in this server/);
  });

  // Draining the words along with the picture leaves a grey card saying nothing. Only the wash and
  // the crest may go quiet; the bar under them keeps full contrast.
  test('the bar under the picture is not dimmed with it', () => {
    expect(STYLES).not.toContain('.server-card[data-present="false"] .server-bar');
    expect(STYLES).not.toContain('.server-card[data-present="false"] .server-name');
  });

  // Every card's button reads "Manage" or "Invite". Without the server's name on the control, a
  // screen reader's link list is five identical entries and the choice cannot be made from it.
  test('each card names its own server on the control, not only beside it', () => {
    expect(PICKER).toMatch(/aria-label=\{`Manage \$\{guild\.name\}`\}/);
    expect(PICKER).toMatch(
      /aria-label=\{`Proton is not in this server[\s\S]*?\$\{guild\.name\}`\}/,
    );
  });
});
