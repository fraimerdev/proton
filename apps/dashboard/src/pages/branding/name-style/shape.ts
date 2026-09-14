import {
  type DisplayNameStyle,
  displayNameStyleSchema,
  NAME_STYLE_COLOURS,
  NAME_STYLE_DEFAULT_COLOUR,
  NAME_STYLE_MAX_COLOURS,
  type NameStyleEffect,
  type NameStyleFont,
  type NameStyleIssue,
  nameStyleWriteIssues,
  sameDisplayNameStyle,
  toHexColour,
} from '@proton/module-branding/name-style';

export type NameStyleChoice = 'none' | 'custom';

export interface NameStyleDraft {
  kind: NameStyleChoice;
  font: NameStyleFont;
  effect: NameStyleEffect;
  slots: readonly number[];
  active: number;
}

export const NAME_STYLE_PRESETS: readonly { label: string; value: number }[] = [
  { label: 'White', value: 0xffffff },
  { label: 'Red', value: 0xf23f43 },
  { label: 'Orange', value: 0xf0b232 },
  { label: 'Yellow', value: 0xfee75c },
  { label: 'Green', value: 0x23a55a },
  { label: 'Cyan', value: 0x0ab9fe },
  { label: 'Blue', value: 0x2a8af7 },
  { label: 'Violet', value: 0x5746ed },
  { label: 'Pink', value: 0xeb459f },
  { label: 'Grey', value: 0x949ba4 },
];

export const SLOT_DEFAULTS: readonly number[] = [
  NAME_STYLE_DEFAULT_COLOUR,
  0x5746ed,
  0xeb459f,
  0xf0b232,
  0x23a55a,
];

export const ROLE_COLOUR_NOTE =
  'In servers, the colour of Proton’s highest coloured role takes priority.';

export const DEFAULT_COLOUR_NOTE =
  'In servers, Proton’s name shows in the colour of its highest coloured role, or Discord’s default.';

export const NAME_STYLE_HELP: readonly string[] = [
  'Fonts show in servers.',
  `Colours and effects show on Proton’s profile. ${ROLE_COLOUR_NOTE}`,
  'Animations don’t play on mobile.',
  'People can turn name styles off in their settings.',
];

export function draftFrom(style: DisplayNameStyle | null): NameStyleDraft {
  if (style === null) {
    return { kind: 'none', font: 'gg-sans', effect: 'solid', slots: SLOT_DEFAULTS, active: 0 };
  }

  return {
    kind: 'custom',
    font: style.font,
    effect: style.effect,
    slots: SLOT_DEFAULTS.map((fallback, index) => style.colours[index] ?? fallback),
    active: 0,
  };
}

export function slotColours(draft: NameStyleDraft, effect: NameStyleEffect): number[] {
  return draft.slots.slice(0, NAME_STYLE_COLOURS[effect]);
}

export function styleFrom(draft: NameStyleDraft): DisplayNameStyle | null {
  if (draft.kind === 'none') return null;

  return { font: draft.font, effect: draft.effect, colours: slotColours(draft, draft.effect) };
}

export function withChoice(draft: NameStyleDraft, kind: NameStyleChoice): NameStyleDraft {
  return { ...draft, kind };
}

export function withFont(draft: NameStyleDraft, font: NameStyleFont): NameStyleDraft {
  return { ...draft, kind: 'custom', font };
}

export function withEffect(draft: NameStyleDraft, effect: NameStyleEffect): NameStyleDraft {
  return {
    ...draft,
    kind: 'custom',
    effect,
    active: Math.min(draft.active, NAME_STYLE_COLOURS[effect] - 1),
  };
}

export function withActive(draft: NameStyleDraft, index: number): NameStyleDraft {
  const last = NAME_STYLE_COLOURS[draft.effect] - 1;
  return { ...draft, active: Math.max(0, Math.min(last, index)) };
}

export function withColour(draft: NameStyleDraft, colour: number): NameStyleDraft {
  return {
    ...draft,
    slots: draft.slots.map((slot, index) => (index === draft.active ? colour : slot)),
  };
}

export function activeColour(draft: NameStyleDraft): number {
  return draft.slots[draft.active] ?? NAME_STYLE_DEFAULT_COLOUR;
}

// An unchanged stored style may stay even when unavailable: refusing Done would trap the admin.
export function canConfirm(draft: NameStyleDraft, value: DisplayNameStyle | null): boolean {
  const next = styleFrom(draft);
  return sameDisplayNameStyle(next, value) || nameStyleWriteIssues(next).length === 0;
}

export function withStagedStyle<C extends { displayNameStyle: DisplayNameStyle | null }>(
  config: C,
  next: DisplayNameStyle | null,
): C {
  return { ...config, displayNameStyle: next };
}

const storedStyleSchema = displayNameStyleSchema.nullable();

export function savedStyleOf(config: Readonly<Record<string, unknown>>): DisplayNameStyle | null {
  const parsed = storedStyleSchema.safeParse(config.displayNameStyle);
  return parsed.success ? parsed.data : null;
}

const CHOOSE_ANOTHER: Readonly<Record<NameStyleIssue['path'], string>> = {
  'displayNameStyle.font': ' Choose another font.',
  'displayNameStyle.effect': ' Choose another effect.',
  'displayNameStyle.colours': '',
};

export function issueAt(
  style: DisplayNameStyle | null,
  path: NameStyleIssue['path'],
): string | undefined {
  const issue = nameStyleWriteIssues(style).find((candidate) => candidate.path === path);
  return issue === undefined ? undefined : `${issue.message}${CHOOSE_ANOTHER[path]}`;
}

export function gridMove(
  index: number,
  key: string,
  count: number,
  columns: number,
): number | null {
  if (count <= 0 || columns <= 0) return null;

  const column = index % columns;

  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'ArrowDown':
      return index + columns < count ? index + columns : column;
    case 'ArrowUp':
      return index - columns >= 0
        ? index - columns
        : column + columns * Math.floor((count - 1 - column) / columns);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function tileMove(
  index: number,
  key: string,
  count: number,
  columns: number,
  blocked: (index: number) => boolean,
): number | null {
  let next = gridMove(index, key, count, columns);
  const step = key === 'Home' ? 'ArrowRight' : key === 'End' ? 'ArrowLeft' : key;

  for (let tries = 0; next !== null && tries < count; tries += 1) {
    if (!blocked(next)) return next;
    next = gridMove(next, step, count, columns);
  }

  return null;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return Array.from(SEGMENTER.segment(text), (part) => part.segment);
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export function isEmoji(grapheme: string): boolean {
  return PICTOGRAPHIC.test(grapheme);
}

export interface GlyphRun {
  text: string;
  missing: boolean;
  start: number;
}

export function runsOf(parts: readonly string[], missing: ReadonlySet<number>): GlyphRun[] {
  const runs: GlyphRun[] = [];

  for (const [index, part] of parts.entries()) {
    const flagged = missing.has(index);
    const last = runs[runs.length - 1];

    if (last !== undefined && last.missing === flagged) last.text += part;
    else runs.push({ text: part, missing: flagged, start: index });
  }

  return runs;
}

export function cssColour(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

export function specimenVars(colours: readonly number[]): Record<`--ns-${number}`, string> {
  const vars: Record<`--ns-${number}`, string> = {};
  if (colours.length === 0) return vars;

  for (let slot = 0; slot < NAME_STYLE_MAX_COLOURS; slot += 1) {
    const colour = colours[slot % colours.length];
    if (colour !== undefined) vars[`--ns-${slot + 1}`] = cssColour(colour);
  }

  return vars;
}

export function colourLabel(value: number): string {
  const preset = NAME_STYLE_PRESETS.find((candidate) => candidate.value === value);
  const hex = toHexColour(value);

  return preset === undefined ? hex : `${preset.label}, ${hex}`;
}
