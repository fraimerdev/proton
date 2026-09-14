import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrandingConfig, brandingConfigSchema } from '@proton/module-branding/config';
import {
  type DisplayNameStyle,
  displayNameStyleSchema,
  isEffectAvailable,
  isFontAvailable,
  NAME_STYLE_COLOURS,
  NAME_STYLE_EFFECTS,
  NAME_STYLE_FONTS,
  NAME_STYLE_UNAVAILABLE_NOTE,
  parseHexColour,
  toHexColour,
} from '@proton/module-branding/name-style';
import type { NameStyleStatus } from '@proton/module-branding/name-style-status';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { NameStyleCard, nameStyleSummary } from '../src/pages/branding/name-style/card.tsx';
import {
  NAME_STYLE_DIALOG_DESCRIPTION,
  NameStyleActions,
  NameStyleEditor,
} from '../src/pages/branding/name-style/dialog.tsx';
import { FACE_RANGES, faceFile, NAME_STYLE_FACES } from '../src/pages/branding/name-style/faces.ts';
import {
  canConfirm,
  colourLabel,
  draftFrom,
  graphemes,
  gridMove,
  isEmoji,
  issueAt,
  NAME_STYLE_HELP,
  type NameStyleDraft,
  runsOf,
  SLOT_DEFAULTS,
  savedStyleOf,
  specimenVars,
  styleFrom,
  tileMove,
  withActive,
  withChoice,
  withColour,
  withEffect,
  withFont,
  withStagedStyle,
} from '../src/pages/branding/name-style/shape.ts';
import { NameSpecimen } from '../src/pages/branding/name-style/specimen.tsx';
import {
  discordShowsText,
  NAME_STYLE_POLL_WINDOW_MS,
  NAME_STYLE_STATUS_TEXT,
  type NameStyleStatusCopy,
  NameStyleStatusLine,
  nameStyleStatusCopy,
  pollTimeLeft,
  reportsNewOutcome,
} from '../src/pages/branding/name-style/status.tsx';

const DASHBOARD = join(import.meta.dir, '..');
const PAGES = join(DASHBOARD, 'src', 'pages');
const NAME_STYLE = join(PAGES, 'branding', 'name-style');

const PREVIEW_ONLY =
  /preview only|not applied in discord|never applied in discord|never sends it to discord|not sent to discord|nothing changes in discord|does not let bots|no way to set|stays in proton/i;

const installedSchema = z.object({ version: z.string(), license: z.string() });
const metadataSchema = z.object({ weights: z.array(z.number()), subsets: z.array(z.string()) });
const manifestSchema = z.object({ dependencies: z.record(z.string(), z.string()) });
const unicodeSchema = z.record(z.string(), z.string());

interface Tile {
  attributes: string;
  text: string;
  label: string;
}

function noop(): void {}

function resolved(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stripTags(markup: string): string {
  return markup.replace(/<[^>]+>/g, '').trim();
}

function buttonTexts(markup: string): string[] {
  return [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    stripTags(match[1] ?? ''),
  );
}

function disabledButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter((match) => /\sdisabled=""/.test(match[1] ?? ''))
    .map((match) => stripTags(match[2] ?? ''));
}

function tilesIn(markup: string): Tile[] {
  return [...markup.matchAll(/<button\b([^>]*role="radio"[^>]*)>([\s\S]*?)<\/button>/g)].map(
    (match) => {
      const inner = match[2] ?? '';
      return {
        attributes: match[1] ?? '',
        text: stripTags(inner),
        label: /class="name-style-tile-label[^"]*"[^>]*>([^<]*)</.exec(inner)?.[1] ?? '',
      };
    },
  );
}

function between(markup: string, from: string, to: string): string {
  const start = markup.indexOf(from);
  const end = markup.indexOf(to, start);
  return markup.slice(start, end === -1 ? undefined : end);
}

function count(markup: string, pattern: RegExp): number {
  return markup.match(pattern)?.length ?? 0;
}

function blockFrom(source: string, open: number): string {
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }

  return source.slice(open);
}

function renderEditor(draft: NameStyleDraft, config: BrandingConfig = BLANK): string {
  return renderToStaticMarkup(
    <NameStyleEditor
      guildId="1"
      config={config}
      read={{ status: 'failed' }}
      draft={draft}
      onDraft={noop}
    />,
  );
}

function renderCard(
  style: DisplayNameStyle | null,
  status: NameStyleStatusCopy | null = null,
  shows: string | null = null,
): string {
  return renderToStaticMarkup(
    <NameStyleCard
      style={style}
      name="Proton"
      status={status}
      shows={shows}
      onCustomise={noop}
      onRemove={noop}
    />,
  );
}

function statusOf(
  state: NameStyleStatus['state'],
  requested: DisplayNameStyle | null,
  reason: NameStyleStatus['reason'] = null,
): NameStyleStatus {
  return { state, reason, requested, lastAttempt: null, confirmed: null };
}

function answeredAt(
  state: NameStyleStatus['state'],
  requested: DisplayNameStyle | null,
  attemptedAt: number,
  confirmedAt: number | null = null,
): NameStyleStatus {
  return {
    ...statusOf(state, requested),
    lastAttempt: {
      style: null,
      outcome: confirmedAt === null ? 'unverified' : 'confirmed',
      reason: null,
      attemptedAt,
      updatedAt: attemptedAt,
    },
    confirmed: confirmedAt === null ? null : { style: null, confirmedAt },
  };
}

function custom(draft: NameStyleDraft): DisplayNameStyle {
  const style = styleFrom(draft);
  if (style === null) throw new Error('expected a custom style');
  return style;
}

const BLANK = brandingConfigSchema.parse({});

const MODERN: DisplayNameStyle = {
  font: 'modern',
  effect: 'gradient',
  colours: [0x5865f2, 0xeb459e],
};
const JOURNAL: DisplayNameStyle = { font: 'journal', effect: 'solid', colours: [0xffffff] };
const PRISM: DisplayNameStyle = { font: 'tempo', effect: 'prism', colours: [1, 2, 3, 4, 5] };

describe('font catalogue', () => {
  test('follows the brief’s order, labels and typefaces, with the substitutions named', () => {
    expect(NAME_STYLE_FACES.map((face) => face.slug)).toEqual([...NAME_STYLE_FONTS]);
    expect(NAME_STYLE_FACES.map((face) => face.label)).toEqual([
      'gg sans',
      'Tempo',
      'Sakura',
      'Jellybean',
      'Modern',
      'Medieval',
      '8Bit',
      'Vampyre',
      'Monkey Bars',
      'Mainframe',
      'Headbang',
      'Journal',
    ]);
    expect(NAME_STYLE_FACES.slice(1).map((face) => face.discordTypeface)).toEqual([
      'Zilla Slab',
      'Cherry Bomb One',
      'Chicle',
      'MuseoModerno',
      'Néo-Castel',
      'Pixelify Sans',
      'Sinistre',
      'Playpen Sans',
      'Orbitron',
      'New Rocker',
      'Kalam',
    ]);

    const slugsWith = (status: string): string[] =>
      NAME_STYLE_FACES.filter((face) => face.status === status).map((face) => face.slug);

    expect(slugsWith('substitute')).toEqual(['gg-sans']);
    expect(slugsWith('stand-in')).toEqual(['medieval', 'vampyre']);
    expect(
      NAME_STYLE_FACES.filter((face) => face.reservedName !== null).map((face) => [
        face.slug,
        face.reservedName,
      ]),
    ).toEqual([
      ['jellybean', 'Chicle'],
      ['headbang', 'New Rocker'],
    ]);

    for (const face of NAME_STYLE_FACES) {
      expect(face.family).toBe(`proton-name-${face.slug}`);
      expect(face.licence).toBe('OFL-1.1');
    }
  });

  test('every package is a dashboard dependency, installed at the catalogued version under OFL-1.1', () => {
    const manifest = manifestSchema.parse(readJson(join(DASHBOARD, 'package.json')));

    for (const face of NAME_STYLE_FACES) {
      expect(manifest.dependencies[face.package]).toBeDefined();

      const installed = installedSchema.parse(readJson(resolved(`${face.package}/package.json`)));
      expect(installed.version).toBe(face.version);
      expect(installed.license).toBe('OFL-1.1');
    }
  });

  test('each face takes its heaviest weight up to 700 and every latin subset the family ships', () => {
    for (const face of NAME_STYLE_FACES) {
      const metadata = metadataSchema.parse(readJson(resolved(`${face.package}/metadata.json`)));
      const weight: number = face.weight;
      const subsets: string[] = [...face.subsets];

      expect(weight).toBe(Math.max(...metadata.weights.filter((shipped) => shipped <= 700)));
      expect(subsets).toEqual(
        ['latin', 'latin-ext'].filter((subset) => metadata.subsets.includes(subset)),
      );
    }
  });

  test('every font file exists and font-files.ts imports exactly those specifiers', () => {
    const source = readFileSync(join(NAME_STYLE, 'font-files.ts'), 'utf8');
    let files = 0;

    for (const face of NAME_STYLE_FACES) {
      for (const subset of face.subsets) {
        const specifier = faceFile(face, subset);
        expect(existsSync(resolved(specifier))).toBe(true);
        expect(source).toContain(`from '${specifier}'`);
        files += 1;
      }
    }

    expect(files).toBe(23);
    expect(count(source, /from '@fontsource\//g)).toBe(23);
  });

  test('the unicode ranges match what every package declares for its subsets', () => {
    for (const face of NAME_STYLE_FACES) {
      const ranges = unicodeSchema.parse(readJson(resolved(`${face.package}/unicode.json`)));
      for (const subset of face.subsets) expect(ranges[subset]).toBe(FACE_RANGES[subset]);
    }
  });

  test('LICENSES.md carries every shipped copyright notice, file and version, and the OFL text', () => {
    const licences = readFileSync(join(NAME_STYLE, 'LICENSES.md'), 'utf8');

    for (const face of NAME_STYLE_FACES) {
      const notice = readFileSync(resolved(`${face.package}/LICENSE`), 'utf8').split('\n')[0];
      const copyright = notice?.trim() ?? '';

      expect(copyright.startsWith('Copyright')).toBe(true);
      expect(licences).toContain(copyright);
      expect(licences).toContain(face.drawnIn);
      expect(licences).toContain(`${face.package}@${face.version}`);

      for (const subset of face.subsets) {
        expect(licences).toContain(faceFile(face, subset).split('/').slice(2).join('/'));
      }

      if (face.reservedName === null) {
        expect(copyright).not.toContain('Reserved Font Name');
      } else {
        expect(copyright).toContain('Reserved Font Name');
        expect(copyright).toContain(face.reservedName);
      }
    }

    expect(licences).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(licences).toContain('PREAMBLE');
  });
});

describe('catalogue availability', () => {
  test('only the fonts and effects Discord applies for apps are selectable', () => {
    expect(NAME_STYLE_FONTS.filter(isFontAvailable)).toEqual([
      'gg-sans',
      'tempo',
      'sakura',
      'jellybean',
      'modern',
      'medieval',
      '8bit',
      'vampyre',
    ]);
    expect(NAME_STYLE_FONTS.filter((font) => !isFontAvailable(font))).toEqual([
      'monkey-bars',
      'mainframe',
      'headbang',
      'journal',
    ]);
    expect(NAME_STYLE_EFFECTS.filter(isEffectAvailable)).toEqual([
      'solid',
      'gradient',
      'neon',
      'toon',
      'pop',
    ]);
    expect(NAME_STYLE_EFFECTS.filter((effect) => !isEffectAvailable(effect))).toEqual([
      'gummy',
      'prism',
    ]);
    expect(NAME_STYLE_UNAVAILABLE_NOTE).toBe('Not available for apps yet');
  });

  test('every unavailable tile is disabled and carries the note, and no tile offers Glow', () => {
    const markup = renderEditor(draftFrom(MODERN));
    const fonts = tilesIn(between(markup, 'Choose font', 'Choose effect'));
    const effects = tilesIn(between(markup, 'Choose effect', 'uses 2 colours'));

    for (const [tiles, unavailable] of [
      [fonts, ['Monkey Bars', 'Mainframe', 'Headbang', 'Journal']],
      [effects, ['Gummy', 'Prism']],
    ] as const) {
      const disabled = tiles.filter((tile) => tile.attributes.includes('aria-disabled="true"'));
      expect(disabled.map((tile) => tile.label)).toEqual([...unavailable]);

      for (const tile of tiles) {
        expect(tile.text.endsWith(NAME_STYLE_UNAVAILABLE_NOTE)).toBe(disabled.includes(tile));
        expect(tile.attributes).not.toContain(' disabled=""');
      }
    }

    expect(fonts).toHaveLength(12);
    expect(effects.map((tile) => tile.label)).toEqual([
      'Solid',
      'Gradient',
      'Neon',
      'Toon',
      'Pop',
      'Gummy',
      'Prism',
    ]);
    expect(markup).not.toMatch(/glow/i);
  });

  test('arrow keys, Home and End skip unavailable tiles', () => {
    const fonts = (index: number): boolean => index >= 8;
    const effects = (index: number): boolean => index >= 5;

    expect(tileMove(7, 'ArrowRight', 12, 4, fonts)).toBe(0);
    expect(tileMove(0, 'ArrowLeft', 12, 4, fonts)).toBe(7);
    expect(tileMove(4, 'ArrowDown', 12, 4, fonts)).toBe(0);
    expect(tileMove(1, 'ArrowUp', 12, 4, fonts)).toBe(5);
    expect(tileMove(3, 'End', 12, 4, fonts)).toBe(7);
    expect(tileMove(9, 'Home', 12, 4, fonts)).toBe(0);
    expect(tileMove(4, 'ArrowRight', 7, 4, effects)).toBe(0);
    expect(tileMove(2, 'ArrowRight', 7, 4, effects)).toBe(3);
    expect(tileMove(0, 'ArrowRight', 3, 3, () => true)).toBeNull();
    expect(tileMove(2, 'Enter', 12, 4, fonts)).toBeNull();
  });

  test('a stored unavailable choice stays selected and is flagged with what to do', () => {
    const journal = renderEditor(draftFrom(JOURNAL));
    expect(journal).toMatch(
      /aria-checked="true" aria-disabled="true" tabindex="0" class="name-style-tile"><span class="name-style-tile-label name-style-tile-face"[^>]*>Journal</,
    );
    expect(journal).toContain('Journal is not available for apps yet. Choose another font.');

    expect(renderEditor(draftFrom(PRISM))).toContain(
      'Prism is not available for apps yet. Choose another effect.',
    );

    expect(issueAt(JOURNAL, 'displayNameStyle.font')).toBe(
      'Journal is not available for apps yet. Choose another font.',
    );
    expect(issueAt(JOURNAL, 'displayNameStyle.effect')).toBeUndefined();
    expect(issueAt({ ...MODERN, colours: [1] }, 'displayNameStyle.colours')).toBe(
      'Gradient takes two colours, not 1.',
    );
    expect(issueAt(null, 'displayNameStyle.font')).toBeUndefined();
  });
});

describe('draft staging', () => {
  test('No style opens as none, with gg sans and Solid shown but not chosen, and stages null', () => {
    const none = draftFrom(null);

    expect(none).toEqual({
      kind: 'none',
      font: 'gg-sans',
      effect: 'solid',
      slots: SLOT_DEFAULTS,
      active: 0,
    });
    expect(styleFrom(none)).toBeNull();

    const markup = renderEditor(none);
    const choices = tilesIn(between(markup, '>Style<', 'Choose font'));
    expect(choices.map((tile) => tile.label)).toEqual(['No style', 'Custom style']);
    expect(choices.map((tile) => tile.attributes.includes('aria-checked="true"'))).toEqual([
      true,
      false,
    ]);

    const fonts = between(markup, 'Choose font', 'Choose effect');
    expect(fonts).not.toContain('aria-checked="true"');
    expect(fonts).toMatch(/tabindex="0" class="name-style-tile"><span[^>]*>gg sans</);
    expect(between(markup, 'Choose effect', '</section>')).not.toContain('aria-checked="true"');
    expect(markup).not.toContain('Presets');
  });

  test('picking a font or effect switches to a custom style, and No style keeps what was picked', () => {
    const tempo = withFont(draftFrom(null), 'tempo');
    expect(custom(tempo)).toEqual({ font: 'tempo', effect: 'solid', colours: [0x2a8af7] });

    const gradient = withEffect(tempo, 'gradient');
    expect(custom(gradient)).toEqual({
      font: 'tempo',
      effect: 'gradient',
      colours: [0x2a8af7, 0x5746ed],
    });

    const removed = withChoice(gradient, 'none');
    expect(styleFrom(removed)).toBeNull();
    expect(styleFrom(withChoice(removed, 'custom'))).toEqual(custom(gradient));
    expect(withEffect(draftFrom(null), 'neon').kind).toBe('custom');
  });

  test('draftFrom and styleFrom round-trip every effect into a valid stored style', () => {
    for (const effect of NAME_STYLE_EFFECTS) {
      const colours = SLOT_DEFAULTS.slice(0, NAME_STYLE_COLOURS[effect]).map(
        (colour) => colour ^ 0x111111,
      );
      const style: DisplayNameStyle = { font: 'journal', effect, colours };
      const back = styleFrom(draftFrom(style));

      expect(back).toEqual(style);
      expect(displayNameStyleSchema.safeParse(back).success).toBe(true);
    }
  });

  test('switching effects keeps all five colours and only ever stores the used ones', () => {
    let draft = withActive(draftFrom(PRISM), 4);

    draft = withEffect(draft, 'solid');
    expect(draft.active).toBe(0);
    expect(custom(draft).colours).toEqual([1]);

    draft = withEffect(draft, 'prism');
    expect(custom(draft).colours).toEqual([1, 2, 3, 4, 5]);

    draft = withEffect(withActive(draft, 4), 'gradient');
    expect(draft.active).toBe(1);

    expect(custom(withColour(withActive(draft, 1), 0xabcdef)).colours).toEqual([1, 0xabcdef]);

    for (const effect of NAME_STYLE_EFFECTS) {
      const stored = custom(withEffect(draft, effect));
      expect(stored.colours).toHaveLength(NAME_STYLE_COLOURS[effect]);
      expect(displayNameStyleSchema.safeParse(stored).success).toBe(true);
    }
  });

  test('Done confirms a style Proton can send, or the saved one left unchanged', () => {
    expect(canConfirm(draftFrom(null), MODERN)).toBe(true);
    expect(canConfirm(draftFrom(MODERN), MODERN)).toBe(true);
    expect(canConfirm(draftFrom(MODERN), null)).toBe(true);
    expect(canConfirm(draftFrom(JOURNAL), JOURNAL)).toBe(true);
    expect(canConfirm(withColour(draftFrom(JOURNAL), 0), JOURNAL)).toBe(false);
    expect(canConfirm(draftFrom(JOURNAL), null)).toBe(false);
    expect(canConfirm(draftFrom(PRISM), MODERN)).toBe(false);
    expect(canConfirm(withFont(draftFrom(JOURNAL), 'tempo'), JOURNAL)).toBe(true);

    const actions = (canDone: boolean): string =>
      renderToStaticMarkup(<NameStyleActions canDone={canDone} onCancel={noop} onDone={noop} />);

    expect(buttonTexts(actions(true))).toEqual(['Cancel', 'Done']);
    expect(disabledButtons(actions(true))).toEqual([]);
    expect(disabledButtons(actions(false))).toEqual(['Done']);
  });

  test('staging writes only the display name style into the page draft', () => {
    const config = brandingConfigSchema.parse({ nickname: 'Sparky', bio: 'Keeps the peace' });
    const staged = withStagedStyle(config, MODERN);

    expect(staged).toEqual({ ...config, displayNameStyle: MODERN });
    expect(config.displayNameStyle).toBeNull();
    expect(withStagedStyle(staged, null)).toEqual(config);
    expect(brandingConfigSchema.parse(staged).displayNameStyle).toEqual(MODERN);
  });

  test('the saved style is read back leniently, and anything unreadable counts as no style', () => {
    expect(savedStyleOf({ displayNameStyle: MODERN })).toEqual(MODERN);
    expect(savedStyleOf({ displayNameStyle: JOURNAL })).toEqual(JOURNAL);
    expect(savedStyleOf({ displayNameStyle: { ...MODERN, colours: [] } })?.colours).toEqual([]);
    expect(savedStyleOf({ displayNameStyle: null })).toBeNull();
    expect(savedStyleOf({})).toBeNull();
    expect(
      savedStyleOf({ displayNameStyle: { font: 'glow', effect: 'solid', colours: [] } }),
    ).toBeNull();
  });

  test('a typed hex colour becomes the integer Proton stores, from 0 to 16777215', () => {
    expect(parseHexColour('#0ab9fe')).toBe(0x0ab9fe);
    expect(parseHexColour('0AB9FE')).toBe(0x0ab9fe);
    expect(parseHexColour(' #0ab9fe ')).toBe(0x0ab9fe);
    expect(parseHexColour('#000000')).toBe(0);
    expect(parseHexColour('#FFFFFF')).toBe(16777215);

    for (const refused of ['#fff', '#12345g', '', '#0ab9fe0']) {
      expect(parseHexColour(refused)).toBeNull();
    }

    expect(toHexColour(0x0ab9fe)).toBe('#0AB9FE');
    expect(toHexColour(0)).toBe('#000000');
    expect(colourLabel(0x2a8af7)).toBe('Blue, #2A8AF7');
    expect(colourLabel(0x123456)).toBe('#123456');
    expect(custom(withColour(draftFrom(MODERN), parseHexColour('#abcdef') ?? -1)).colours).toEqual([
      0xabcdef, 0xeb459e,
    ]);
  });

  test('moves through a grid with wrapping arrows, Home and End', () => {
    expect(gridMove(11, 'ArrowRight', 12, 4)).toBe(0);
    expect(gridMove(0, 'ArrowLeft', 12, 4)).toBe(11);
    expect(gridMove(9, 'ArrowDown', 12, 4)).toBe(1);
    expect(gridMove(1, 'ArrowUp', 12, 4)).toBe(9);
    expect(gridMove(2, 'ArrowDown', 12, 4)).toBe(6);
    expect(gridMove(3, 'ArrowDown', 7, 4)).toBe(3);
    expect(gridMove(3, 'ArrowUp', 7, 4)).toBe(3);
    expect(gridMove(5, 'Home', 12, 4)).toBe(0);
    expect(gridMove(5, 'End', 12, 4)).toBe(11);
    expect(gridMove(5, 'Enter', 12, 4)).toBeNull();
    expect(gridMove(9, 'ArrowDown', 10, 1)).toBe(0);
    expect(gridMove(0, 'ArrowUp', 10, 1)).toBe(9);
  });

  test('splits graphemes, merges missing runs and leaves emoji alone', () => {
    expect(graphemes('Straße 🙂')).toHaveLength(8);
    expect(graphemes('é')).toHaveLength(1);

    expect(runsOf(['a', 'b', 'c', 'd'], new Set([1, 2]))).toEqual([
      { text: 'a', missing: false, start: 0 },
      { text: 'bc', missing: true, start: 1 },
      { text: 'd', missing: false, start: 3 },
    ]);

    expect(isEmoji('🙂')).toBe(true);
    expect(isEmoji('👍🏽')).toBe(true);
    expect(isEmoji('ß')).toBe(false);
  });

  test('repeats the stored colours across all five specimen variables', () => {
    expect(specimenVars([0x112233, 0x445566])).toEqual({
      '--ns-1': '#112233',
      '--ns-2': '#445566',
      '--ns-3': '#112233',
      '--ns-4': '#445566',
      '--ns-5': '#112233',
    });
    expect(specimenVars([])).toEqual({});
  });
});

describe('status copy', () => {
  const copy = (
    status: NameStyleStatus | undefined,
    changes: Partial<Parameters<typeof nameStyleStatusCopy>[0]> = {},
  ): NameStyleStatusCopy | null =>
    nameStyleStatusCopy({
      status,
      failed: false,
      saved: MODERN,
      draft: MODERN,
      pollingOver: false,
      ...changes,
    });

  test('every state reads as the owner’s wording', () => {
    expect(copy(statusOf('applied', MODERN))).toEqual({
      text: 'Applied in Discord',
      tone: 'success',
      busy: false,
    });
    expect(copy(statusOf('applying', MODERN))).toEqual({
      text: 'Applying…',
      tone: 'neutral',
      busy: true,
    });
    expect(copy(statusOf('ignored', MODERN, 'discord_ignored'))).toEqual({
      text: 'Discord didn’t accept this style',
      tone: 'danger',
      busy: false,
    });
    expect(copy(statusOf('rejected', MODERN, 'discord_refused'))?.text).toBe(
      'Discord didn’t accept this style',
    );
    expect(copy(statusOf('rejected', MODERN, 'missing_change_nickname'))).toEqual({
      text: 'Proton needs Change Nickname in this server',
      tone: 'danger',
      busy: false,
    });

    for (const reason of ['no_answer', 'not_readable', 'changed_in_discord'] as const) {
      expect(copy(statusOf('unverified', MODERN, reason))).toEqual({
        text: 'Couldn’t confirm with Discord',
        tone: 'warning',
        busy: false,
      });
    }

    expect(copy(statusOf('off', MODERN))?.text).toBe('Applies when Branding is switched on');
    expect(copy(statusOf('none', null), { saved: null, draft: null })).toBeNull();
    expect(copy(statusOf('unavailable', JOURNAL), { saved: JOURNAL, draft: JOURNAL })).toEqual({
      text: 'Journal is not available for apps yet. Choose another font.',
      tone: 'warning',
      busy: false,
    });
    expect(copy(statusOf('unavailable', PRISM), { saved: PRISM, draft: PRISM })?.text).toBe(
      'Prism is not available for apps yet. Choose another effect.',
    );
  });

  test('loading, failure, an unsaved draft and an answer about an earlier save', () => {
    expect(copy(undefined)).toEqual({ text: 'Checking with Discord', tone: 'neutral', busy: true });
    expect(copy(undefined, { failed: true })).toEqual({
      text: 'Couldn’t check the style’s status.',
      tone: 'warning',
      busy: false,
    });

    const unsaved: NameStyleStatusCopy = {
      text: 'Save to apply in Discord',
      tone: 'neutral',
      busy: false,
    };
    expect(copy(statusOf('applied', MODERN), { draft: null })).toEqual(unsaved);
    expect(copy(undefined, { draft: JOURNAL, failed: true })).toEqual(unsaved);

    expect(copy(statusOf('applied', JOURNAL))?.text).toBe('Checking with Discord');
    expect(copy(statusOf('applied', JOURNAL), { failed: true })).toEqual({
      text: 'Couldn’t check the style’s status.',
      tone: 'warning',
      busy: false,
    });
  });

  test('a failed refetch still shows the outcome of an answer about the saved style', () => {
    expect(copy(statusOf('applied', MODERN), { failed: true })).toEqual({
      text: 'Applied in Discord',
      tone: 'success',
      busy: false,
    });
    expect(copy(statusOf('applying', MODERN), { failed: true })?.text).toBe('Applying…');

    const page = readFileSync(join(PAGES, 'branding.tsx'), 'utf8');
    expect(page).toContain('failed: query.isError,');
    expect(page).not.toContain('query.data === undefined');
  });

  test('after two minutes of polling, Applying… stays but its spinner goes', () => {
    expect(copy(statusOf('applying', MODERN), { pollingOver: true })).toEqual({
      text: 'Applying…',
      tone: 'neutral',
      busy: false,
    });

    expect(NAME_STYLE_POLL_WINDOW_MS).toBe(120_000);
    expect(pollTimeLeft(1_000, 1_000)).toBe(120_000);
    expect(pollTimeLeft(1_000, 120_000)).toBe(1_000);
    expect(pollTimeLeft(1_000, 121_000)).toBe(0);
    expect(pollTimeLeft(1_000, 500_000)).toBe(0);

    const busy = renderToStaticMarkup(
      <NameStyleStatusLine copy={{ text: 'Applying…', tone: 'neutral', busy: true }} />,
    );
    expect(busy).toContain('class="spinner"');
    expect(stripTags(busy)).toBe('Applying…');

    const still = renderToStaticMarkup(
      <NameStyleStatusLine copy={{ text: 'Applied in Discord', tone: 'success', busy: false }} />,
    );
    expect(still).toBe(
      '<span class="name-style-status" data-tone="success">Applied in Discord</span>',
    );
    expect(renderToStaticMarkup(<NameStyleStatusLine copy={null} />)).toBe('');
  });

  test('no status line uses API terms or claims more than Discord confirmed', () => {
    for (const text of Object.values(NAME_STYLE_STATUS_TEXT)) {
      expect(text).not.toMatch(/[_{}]|\b(api|http|patch|payload|null|error|request)\b/i);
      expect(text).not.toMatch(PREVIEW_ONLY);
    }
  });

  test('the live member read is refreshed whenever the saved style gets a new outcome, however fast it came', () => {
    const before = answeredAt('applied', JOURNAL, 100, 100);

    expect(reportsNewOutcome(before, answeredAt('applied', MODERN, 200, 200), MODERN)).toBe(true);
    expect(reportsNewOutcome(before, answeredAt('rejected', MODERN, 200), MODERN)).toBe(true);
    expect(
      reportsNewOutcome(
        answeredAt('applying', MODERN, 100),
        answeredAt('applied', MODERN, 200, 200),
        MODERN,
      ),
    ).toBe(true);
    expect(
      reportsNewOutcome(
        answeredAt('unverified', MODERN, 200),
        answeredAt('applied', MODERN, 200, 260),
        MODERN,
      ),
    ).toBe(true);
    expect(
      reportsNewOutcome(
        answeredAt('applied', MODERN, 200, 200),
        answeredAt('applied', MODERN, 300, 300),
        MODERN,
      ),
    ).toBe(true);
    expect(reportsNewOutcome(statusOf('applying', null), statusOf('none', null), null)).toBe(true);
  });

  test('the live member read is left alone when nothing new was reported about the saved style', () => {
    const applied = answeredAt('applied', MODERN, 200, 200);

    expect(reportsNewOutcome(applied, answeredAt('applied', MODERN, 200, 200), MODERN)).toBe(false);
    expect(reportsNewOutcome(applied, applied, MODERN)).toBe(false);
    expect(reportsNewOutcome(applied, answeredAt('applying', MODERN, 200, 200), MODERN)).toBe(
      false,
    );
    expect(
      reportsNewOutcome(
        answeredAt('applied', JOURNAL, 100, 100),
        answeredAt('applied', JOURNAL, 100, 100),
        MODERN,
      ),
    ).toBe(false);
    expect(reportsNewOutcome(applied, answeredAt('applied', JOURNAL, 300, 300), MODERN)).toBe(
      false,
    );
    expect(reportsNewOutcome(applied, undefined, MODERN)).toBe(false);
    expect(reportsNewOutcome(undefined, applied, MODERN)).toBe(false);
  });

  test('the page refreshes the member read from the outcome, not from having seen Applying…', () => {
    const page = readFileSync(join(PAGES, 'branding.tsx'), 'utf8');

    expect(page).toContain('reportsNewOutcome(before, data, saved)');
    expect(page).toContain('queryKey: queryKeys.protonAccount(guildId)');
    expect(page).not.toContain('wasApplying');
  });

  test('Discord shows names what the live member read carries, or leaves the line out', () => {
    expect(discordShowsText(undefined)).toBeNull();
    expect(discordShowsText(null)).toBe('Discord shows: No style');
    expect(discordShowsText({ fontId: 6, effectId: 2, colours: [0x5865f2, 0xeb459e] })).toBe(
      'Discord shows: Modern · Gradient',
    );
    expect(discordShowsText({ fontId: 13, effectId: 1, colours: [] })).toBe(
      'Discord shows: Monkey Bars · Solid',
    );
    expect(discordShowsText({ fontId: 1, effectId: 2, colours: [0] })).toBe(
      'Discord shows: a style Proton doesn’t offer',
    );
    expect(discordShowsText({ fontId: 11, effectId: 6, colours: [0] })).toBe(
      'Discord shows: a style Proton doesn’t offer',
    );
  });
});

describe('markup', () => {
  test('the card shows No style, or the style with a way to remove it', () => {
    const none = renderCard(null);
    expect(none).toContain('<p class="name-style-card-summary">No style</p>');
    expect(buttonTexts(none)).toEqual(['Customise']);
    expect(none).not.toContain('name-specimen');

    const modern = renderCard(
      MODERN,
      { text: 'Applied in Discord', tone: 'success', busy: false },
      'Discord shows: Modern · Gradient',
    );
    expect(modern).toContain('Modern · Gradient');
    expect(modern).toContain('data-tone="success">Applied in Discord<');
    expect(modern).toContain(
      '<p class="name-style-card-shows">Discord shows: Modern · Gradient</p>',
    );
    expect(buttonTexts(modern)).toEqual(['Customise', 'Remove style']);

    expect(nameStyleSummary({ font: 'medieval', effect: 'solid', colours: [0xffffff] })).toBe(
      'Medieval (shown in MedievalSharp) · Solid',
    );
    expect(nameStyleSummary(null)).toBe('No style');
  });

  test('the card flags a stored unavailable style once, even when the status says the same', () => {
    const flag = 'Journal is not available for apps yet. Choose another font.';

    expect(count(renderCard(JOURNAL), new RegExp(flag.replace(/\./g, '\\.'), 'g'))).toBe(1);
    expect(
      count(
        renderCard(JOURNAL, { text: flag, tone: 'warning', busy: false }),
        new RegExp(flag.replace(/\./g, '\\.'), 'g'),
      ),
    ).toBe(1);
  });

  test('nothing on the page, the editor or its source still says the style is preview only', () => {
    const markups = [
      renderCard(null),
      renderCard(MODERN),
      renderEditor(draftFrom(null)),
      renderEditor(draftFrom(PRISM)),
      renderToStaticMarkup(<NameStyleActions canDone onCancel={noop} onDone={noop} />),
      NAME_STYLE_DIALOG_DESCRIPTION,
      ...NAME_STYLE_HELP,
    ];
    for (const markup of markups) expect(markup).not.toMatch(PREVIEW_ONLY);

    const sources = readdirSync(NAME_STYLE)
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => join(NAME_STYLE, file));
    for (const file of [
      ...sources,
      join(PAGES, 'branding.tsx'),
      join(PAGES, 'branding', 'discord-preview.tsx'),
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(PREVIEW_ONLY);
    }

    expect(existsSync(join(NAME_STYLE, 'save.ts'))).toBe(false);
    expect(NAME_STYLE_DIALOG_DESCRIPTION).toBe(
      'Choose how Proton’s name looks in this server. Save the page to apply it in Discord.',
    );
  });

  test('the page saves the style through the SaveBar, and its success claims nothing about Discord', () => {
    const page = readFileSync(join(PAGES, 'branding.tsx'), 'utf8');

    expect(page).toContain('failures={form.failures}');
    expect(page).toContain('onReset={form.reset}');
    expect(page).toContain(
      'note="Saving sends Proton’s nickname, bio and display name style to Discord."',
    );
    expect(page).not.toMatch(
      /nameEffect|primaryColor|secondaryColor|ENHANCED_COLOURS|Role colour|ColourPicker|module-branding\/colour/,
    );
    expect(page).toContain('withStagedStyle(current, next)');
    expect(page).toContain('withStagedStyle(current, null)');
    expect(page).not.toMatch(/useSaveNameStyle|updateModuleConfig|<Badge/);
    expect(page).toContain(
      'description="Remove the server nickname, avatar, banner, bio and display name style."',
    );
  });

  test('the editor draws its choice, twelve font tiles and seven effect tiles, one tab stop each', () => {
    const markup = renderEditor(draftFrom(MODERN));

    const fonts = [
      ...markup.matchAll(/class="name-style-tile-label name-style-tile-face"[^>]*>([^<]*)</g),
    ].map((match) => match[1]);
    expect(fonts).toEqual(NAME_STYLE_FACES.map((face) => face.label));

    const labels = [...markup.matchAll(/class="name-style-tile-label">([^<]*)</g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual([
      'No style',
      'Custom style',
      'Solid',
      'Gradient',
      'Neon',
      'Toon',
      'Pop',
      'Gummy',
      'Prism',
    ]);

    expect(markup).toMatch(
      /aria-checked="true" tabindex="0" class="name-style-tile"><span class="name-style-tile-label name-style-tile-face"[^>]*>Modern</,
    );
    expect(count(markup, /role="radiogroup" aria-labelledby=/g)).toBe(5);
    expect(count(markup, /tabindex="0"/g)).toBe(5);
  });

  test('the colour controls follow the effect: none without a style, one for Solid, two for Gradient', () => {
    const presets = 10;
    const slotsFor = (draft: NameStyleDraft): number =>
      count(renderEditor(draft), /name-style-swatch-tile/g) - presets;

    expect(count(renderEditor(draftFrom(null)), /name-style-swatch-tile/g)).toBe(0);
    expect(slotsFor(draftFrom({ font: 'tempo', effect: 'solid', colours: [1] }))).toBe(0);
    expect(slotsFor(draftFrom(MODERN))).toBe(2);
    expect(slotsFor(draftFrom(PRISM))).toBe(5);
  });

  test('the specimen carries its face, effect and five colours, and marks missing glyphs', () => {
    const markup = renderToStaticMarkup(
      <NameSpecimen
        font="mainframe"
        effect="prism"
        colours={[0xf23f43, 0xf0b232, 0xfee75c, 0x23a55a, 0x5746ed]}
        text="Straße"
        missing={new Set([4])}
      />,
    );

    expect(markup).toContain('data-effect="prism"');
    expect(markup).toContain('--ns-5:#5746ed');
    expect(markup).toContain('proton-name-mainframe');
    expect(markup).toContain('<span class="name-specimen-missing">ß</span>');
  });

  test('previews render still without motion preference, and motion lives only behind no-preference', () => {
    const markup = renderEditor(draftFrom(PRISM));
    expect(markup).toContain('data-motion="still"');
    expect(markup).toContain('Still, because your device asks for reduced motion.');

    const css = readFileSync(join(DASHBOARD, 'src', 'styles', 'modules', 'branding.css'), 'utf8');
    expect(/\.name-specimen \{[^}]*\}/.exec(css)?.[0]).toContain('font-synthesis: none');

    const guard = '@media (prefers-reduced-motion: no-preference) {';
    const start = css.indexOf(guard);
    expect(start).toBeGreaterThan(-1);

    const block = blockFrom(css, start + guard.length - 1);
    expect(count(css, /animation:\s*name-/g)).toBe(3);
    expect(count(block, /animation:\s*name-/g)).toBe(3);
    for (const effect of ['neon', 'gummy', 'prism']) {
      expect(block).toContain(`[data-motion="animated"] .name-specimen[data-effect="${effect}"]`);
    }
    expect(css).not.toMatch(/glow/i);
  });

  test('the Still setting stops every animation, and only name style effects animate', () => {
    const css = readFileSync(join(DASHBOARD, 'src', 'styles', 'modules', 'branding.css'), 'utf8');
    const guard = '@media (prefers-reduced-motion: no-preference) {';

    const guarded = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{/g)]
      .map((match) => blockFrom(css, (match.index ?? 0) + guard.length - 1))
      .join('\n');
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\banimation:/g)].flatMap((match) =>
      (match[1] ?? '').split(',').map((selector) => selector.trim()),
    );

    expect(count(css, /\banimation:/g)).toBe(3);
    expect(count(guarded, /\banimation:/g)).toBe(3);
    expect(selectors).toHaveLength(3);
    for (const selector of selectors) {
      expect(selector.startsWith('[data-motion="animated"] .name-specimen[data-effect=')).toBe(
        true,
      );
    }
  });

  test('a server message draws the chosen font in Discord’s default name colour, and the profile in the style’s', () => {
    const config = brandingConfigSchema.parse({ nickname: 'Sparky' });
    const markup = renderEditor(
      draftFrom({ font: 'modern', effect: 'solid', colours: [0xff0000] }),
      config,
    );
    const profile = between(markup, 'data-pane="profile"', 'data-pane="message"');
    const message = between(markup, 'data-pane="message"', 'name-style-notes');

    expect(profile).toContain('--ns-1:#ff0000');
    expect(message).toMatch(
      /<span class="branding-name dc-author" style="font-family:&quot;proton-name-modern&quot;[^"]*font-synthesis:none">/,
    );
    expect(message).not.toMatch(/--role-|data-paint|(^|[;"])color:/);
    expect(message).not.toContain('#ff0000');
    expect(message).not.toContain('name-specimen');

    const none = renderEditor(draftFrom(null), config);
    expect(between(none, 'data-pane="profile"', 'data-pane="message"')).not.toContain(
      'name-specimen',
    );
    expect(between(none, 'data-pane="message"', 'name-style-notes')).not.toContain('proton-name-');
    expect(none).not.toContain('Discord draws this as');
  });

  test('the notes name substitutes and stand-ins, and always carry the short help', () => {
    const gg = renderEditor(draftFrom({ font: 'gg-sans', effect: 'solid', colours: [1] }));
    expect(gg).toContain('This preview uses Inter instead.');
    expect(
      renderEditor(draftFrom({ font: 'vampyre', effect: 'solid', colours: [0xffffff] })),
    ).toContain(
      'Discord draws Vampyre in Sinistre, which Proton does not include yet. This preview uses Grenze Gotisch.',
    );

    const none = renderEditor(draftFrom(null));
    expect(none).not.toContain('This preview uses');

    for (const markup of [gg, none]) {
      for (const line of NAME_STYLE_HELP) expect(markup).toContain(line);
    }
    expect(NAME_STYLE_HELP).toEqual([
      'Fonts show in servers.',
      'Colours and effects show on Proton’s profile. In servers, the colour of Proton’s highest coloured role takes priority.',
      'Animations don’t play on mobile.',
      'People can turn name styles off in their settings.',
    ]);
  });
});
