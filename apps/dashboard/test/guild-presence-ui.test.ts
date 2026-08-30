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
    expect(PICKER).toContain(`data-present={absent ? 'false' : undefined}`);
    expect(SHELL).toContain(`data-present={absent ? 'false' : undefined}`);
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
    expect(PICKER).toMatch(/`Proton is not in this server[\s\S]*?\$\{guild\.name\}`/);
    expect(PICKER).toMatch(/`Invite Proton to \$\{guild\.name\}`/);
  });
});

/**
 * Presence is answered by Discord, so it has a third state: unreachable. Rendering that as absence
 * puts "Proton is not in this server" on every card at once, over nothing worse than a failed call
 * — and rendering it as presence hands out settings pages whose saves go nowhere.
 */
describe('presence that could not be checked', () => {
  test('neither list claims absence unless the answer was actually had', () => {
    expect(PICKER).toContain('const absent = presenceKnown && !guild.present;');
    expect(SHELL).toContain('const absent = presenceKnown && !candidate.present;');
  });

  test('the picker says so once, above the grid, rather than on every card', () => {
    expect(PICKER).toContain('Proton could not check which of these servers it is in');
  });

  test('a card with no invite to offer stops short of asserting Proton left', () => {
    expect(PICKER).toContain(
      `{absent ? 'Proton is not in this server' : 'Proton could not check this server'}`,
    );
  });

  // Manage is the affordance that does damage when it is wrong: it opens a settings page whose
  // every switch saves into a guild nothing is listening in.
  test('Manage is still gated on a positive answer, never on the absence of a negative', () => {
    expect(PICKER).toContain('{guild.present ? (');
  });
});
