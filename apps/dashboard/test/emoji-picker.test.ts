import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMOJI_GROUPS } from '../src/components/emoji/emoji-set.gen.ts';
import { emojiImageUrl } from '../src/components/emoji/glyph.tsx';
import { buildSections } from '../src/components/emoji/panel.tsx';
import { placePopover } from '../src/components/form/picker.tsx';

const SRC = join(import.meta.dir, '..', 'src');

const CATALOG = {
  guildName: 'Ventus Lounge',
  guildIcon: 'https://cdn.discordapp.com/icons/1/abc.png?size=64',
  emojis: [
    { id: '111111111111111111', name: 'partyparrot', animated: true },
    { id: '222222222222222222', name: 'starstruck', animated: false },
  ],
};

describe('the sections the picker draws', () => {
  test("put the server's own emoji above every unicode group", () => {
    const sections = buildSections(CATALOG, '');

    expect(sections[0]?.label).toBe('Ventus Lounge');
    expect(sections[1]?.label).toBe('Smileys & Emotion');
  });

  // The rail draws the crest for the server section and a representative glyph for the rest, so a
  // server with no icon has to fall back to something rather than an empty button.
  test('the server section carries the crest when there is one, and a glyph when there is not', () => {
    expect(buildSections(CATALOG, '')[0]?.iconUrl).toBe(CATALOG.guildIcon);
    expect(buildSections({ ...CATALOG, guildIcon: null }, '')[0]?.iconUrl).toBeUndefined();
    expect(buildSections({ ...CATALOG, guildIcon: null }, '')[0]?.icon).not.toBe('');
  });

  test('a server with no emoji of its own is not given an empty section', () => {
    const sections = buildSections({ ...CATALOG, emojis: [] }, '');

    expect(sections.map((section) => section.label)).not.toContain('Ventus Lounge');
    expect(sections[0]?.label).toBe('Smileys & Emotion');
  });

  /**
   * A custom emoji is stored the way Discord writes it in message content, which is also what
   * `parseComponentEmoji` reads back — the picker must not invent a second spelling.
   */
  test('a custom emoji is stored as its Discord tag, animated ones with the a flag', () => {
    const cells = buildSections(CATALOG, '')[0]?.cells ?? [];

    expect(cells[0]?.value).toBe('<a:partyparrot:111111111111111111>');
    expect(cells[1]?.value).toBe('<:starstruck:222222222222222222>');
  });

  test('a unicode emoji is stored as the bare character', () => {
    const smileys = buildSections(CATALOG, '').find((s) => s.label === 'Smileys & Emotion');

    expect(smileys?.cells[0]?.value).toBe('😀');
  });
});

describe('searching', () => {
  test('matches this server’s emoji and unicode names together', () => {
    const labels = buildSections(CATALOG, 'star').flatMap((s) => s.cells.map((c) => c.name));

    expect(labels).toContain('starstruck');
    expect(labels).toContain('star');
  });

  // Nine headings over nothing is not a result list.
  test('drops every section the query emptied', () => {
    const sections = buildSections(CATALOG, 'partyparrot');

    expect(sections).toHaveLength(1);
    expect(sections[0]?.label).toBe('Ventus Lounge');
  });

  test('answers a query nothing matches with no sections at all', () => {
    expect(buildSections(CATALOG, 'zzzznotanemoji')).toHaveLength(0);
  });

  // Typed the way an emoji is written in chat. Without stripping them, ':star:' matched nothing.
  test('tolerates the colons somebody types around a name', () => {
    expect(buildSections(CATALOG, ':star:').length).toBeGreaterThan(0);
  });
});

/**
 * Verified against docs.discord.com/developers/reference. An animated emoji served without the
 * flag is a still first frame, which is the bug this pins.
 */
describe('the CDN url', () => {
  test('asks for webp at a power-of-two size', () => {
    expect(emojiImageUrl('123', false)).toBe('https://cdn.discordapp.com/emojis/123.webp?size=64');
  });

  test('flags an animated emoji so it is not served as a still', () => {
    expect(emojiImageUrl('123', true)).toContain('&animated=true');
  });
});

/**
 * A settings row's control column is most of the way across the window, and a laptop-height window
 * has room for the full panel neither above a mid-page field nor below it. Both cases put the panel
 * off the screen before this existed.
 *
 * The panel's own `placeFor` is gone: the emoji panel is a `.popover` now, placed by the one
 * `placePopover` every overlay in the product shares, so these are the same cases asked of it.
 */
describe('where the panel opens', () => {
  const viewport = { width: 1440, height: 900 };
  const want = { width: 356, height: 420 };
  const at = (left: number, top: number, height = 36) =>
    ({ left, top, bottom: top + height, right: left + 220, width: 220 }) as DOMRect;

  test('is pulled back inside the window when a left-anchored panel would leave it', () => {
    expect(placePopover(at(1180, 300), viewport, want).left).toBe(1440 - 356 - 8);
    expect(placePopover(at(200, 300), viewport, want).left).toBe(200);
  });

  test('opens upward only when there is more room above than below', () => {
    expect(placePopover(at(200, 100), viewport, want).drop).toBe('down');
    expect(placePopover(at(200, 800), viewport, want).drop).toBe('up');
  });

  test('takes the whole panel when the room is there', () => {
    expect(placePopover(at(200, 100), viewport, want).maxHeight).toBe(420);
  });

  // The case that sent it off the bottom of a 620px window: 271px below, 279px above, and a panel
  // that assumed 420 either way.
  test('shrinks to the better side rather than overflowing', () => {
    const placement = placePopover(at(200, 293), { width: 1440, height: 620 }, want);

    expect(placement.drop).toBe('up');
    expect(placement.maxHeight).toBe(293 - 6 - 8);
  });

  test('stops shrinking at a panel too small to browse', () => {
    expect(placePopover(at(200, 120), { width: 1440, height: 260 }, want).maxHeight).toBe(160);
  });
});

describe('the generated unicode set', () => {
  test('covers the nine groups in the order the rail draws them', () => {
    expect(EMOJI_GROUPS.map((group) => group.id)).toEqual([
      'smileys',
      'people',
      'nature',
      'food',
      'activities',
      'travel',
      'objects',
      'symbols',
      'flags',
    ]);
  });

  test('every group has a label, an icon and emoji in it', () => {
    for (const group of EMOJI_GROUPS) {
      expect(`${group.id}: ${group.label !== ''}`).toBe(`${group.id}: true`);
      expect(`${group.id}: ${group.icon !== ''}`).toBe(`${group.id}: true`);
      expect(`${group.id}: ${group.emojis.length > 0}`).toBe(`${group.id}: true`);
    }
  });
});

/**
 * The set is ~95KB and the trigger is imported by form/fields.tsx, which every module page pulls
 * in. A static import of the panel anywhere in that chain puts the whole table in the first chunk,
 * and nothing about the page would look wrong — it would just be 95KB heavier on every visit.
 */
test('the panel, and so the emoji table, is only ever reached through a dynamic import', () => {
  const picker = readFileSync(join(SRC, 'components', 'emoji', 'picker.tsx'), 'utf8');

  expect(picker).toContain("await import('./panel.tsx')");
  expect(picker).not.toMatch(/^import .*from '\.\/panel\.tsx';$/m);
  expect(picker).not.toMatch(/^import .*from '\.\/emoji-set\.gen\.ts';$/m);
});
