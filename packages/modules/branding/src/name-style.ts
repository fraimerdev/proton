import { type BotNameStyle, protonFields } from '@proton/core';
import { z } from 'zod';

export const NAME_STYLE_FONTS = [
  'gg-sans',
  'tempo',
  'sakura',
  'jellybean',
  'modern',
  'medieval',
  '8bit',
  'vampyre',
  'monkey-bars',
  'mainframe',
  'headbang',
  'journal',
] as const;

export type NameStyleFont = (typeof NAME_STYLE_FONTS)[number];

export const NAME_STYLE_EFFECTS = [
  'solid',
  'gradient',
  'neon',
  'toon',
  'pop',
  'gummy',
  'prism',
] as const;

export type NameStyleEffect = (typeof NAME_STYLE_EFFECTS)[number];

export interface NameStyleFontEntry {
  label: string;
  id: number;
  available: boolean;
}

export interface NameStyleEffectEntry {
  label: string;
  id: number;
  colours: number;
  available: boolean;
}

type Catalogue<K extends string, E> = Readonly<Record<K, E>>;

export const NAME_STYLE_FONT_CATALOGUE: Catalogue<NameStyleFont, NameStyleFontEntry> = {
  'gg-sans': { label: 'gg sans', id: 11, available: true },
  tempo: { label: 'Tempo', id: 12, available: true },
  sakura: { label: 'Sakura', id: 3, available: true },
  jellybean: { label: 'Jellybean', id: 4, available: true },
  modern: { label: 'Modern', id: 6, available: true },
  medieval: { label: 'Medieval', id: 7, available: true },
  '8bit': { label: '8Bit', id: 8, available: true },
  vampyre: { label: 'Vampyre', id: 10, available: true },
  'monkey-bars': { label: 'Monkey Bars', id: 13, available: false },
  mainframe: { label: 'Mainframe', id: 14, available: false },
  headbang: { label: 'Headbang', id: 15, available: false },
  journal: { label: 'Journal', id: 16, available: false },
};

export const NAME_STYLE_EFFECT_CATALOGUE: Catalogue<NameStyleEffect, NameStyleEffectEntry> = {
  solid: { label: 'Solid', id: 1, colours: 1, available: true },
  gradient: { label: 'Gradient', id: 2, colours: 2, available: true },
  neon: { label: 'Neon', id: 3, colours: 1, available: true },
  toon: { label: 'Toon', id: 4, colours: 1, available: true },
  pop: { label: 'Pop', id: 5, colours: 1, available: true },
  gummy: { label: 'Gummy', id: 8, colours: 4, available: false },
  prism: { label: 'Prism', id: 7, colours: 5, available: false },
};

export const NAME_STYLE_UNAVAILABLE_NOTE = 'Not available for apps yet';

function mapEntries<K extends string, E, V>(catalogue: Catalogue<K, E>, of: (entry: E) => V) {
  const entries = Object.entries(catalogue) as [K, E][];
  return Object.fromEntries(entries.map(([key, entry]) => [key, of(entry)])) as Record<K, V>;
}

export const NAME_STYLE_FONT_LABELS = mapEntries(NAME_STYLE_FONT_CATALOGUE, (e) => e.label);

export const NAME_STYLE_EFFECT_LABELS = mapEntries(NAME_STYLE_EFFECT_CATALOGUE, (e) => e.label);

export const NAME_STYLE_COLOURS = mapEntries(NAME_STYLE_EFFECT_CATALOGUE, (e) => e.colours);

export const NAME_STYLE_MAX_COLOURS = 5;

export const NAME_STYLE_DEFAULT_COLOUR = 0x2a8af7;

const colour = z.number().int().min(0).max(0xffffff);

export const displayNameStyleSchema = z.object({
  font: z.enum(NAME_STYLE_FONTS).register(protonFields, { label: 'Display name font' }),
  effect: z.enum(NAME_STYLE_EFFECTS).register(protonFields, { label: 'Display name effect' }),
  colours: z
    .array(colour)
    .max(NAME_STYLE_MAX_COLOURS, { abort: true })
    .register(protonFields, { field: 'colour', label: 'Display name colours' }),
});

export type DisplayNameStyle = z.infer<typeof displayNameStyleSchema>;

export function isFontAvailable(font: NameStyleFont): boolean {
  return NAME_STYLE_FONT_CATALOGUE[font].available;
}

export function isEffectAvailable(effect: NameStyleEffect): boolean {
  return NAME_STYLE_EFFECT_CATALOGUE[effect].available;
}

function sameColours(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function sameDisplayNameStyle(
  a: DisplayNameStyle | null,
  b: DisplayNameStyle | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.font === b.font && a.effect === b.effect && sameColours(a.colours, b.colours);
}

export function sameWireStyle(a: BotNameStyle | null, b: BotNameStyle | null): boolean {
  if (a === null || b === null) return a === b;
  return a.fontId === b.fontId && a.effectId === b.effectId && sameColours(a.colours, b.colours);
}

export interface NameStyleIssue {
  path: 'displayNameStyle.font' | 'displayNameStyle.effect' | 'displayNameStyle.colours';
  message: string;
}

const COLOUR_COUNT: Readonly<Record<number, string>> = {
  1: 'one colour',
  2: 'two colours',
  3: 'three colours',
  4: 'four colours',
  5: 'five colours',
};

export function nameStyleWriteIssues(style: DisplayNameStyle | null): NameStyleIssue[] {
  if (style === null) return [];

  const issues: NameStyleIssue[] = [];
  const font = NAME_STYLE_FONT_CATALOGUE[style.font];
  const effect = NAME_STYLE_EFFECT_CATALOGUE[style.effect];

  if (!font.available) {
    issues.push({
      path: 'displayNameStyle.font',
      message: `${font.label} is not available for apps yet.`,
    });
  }

  if (!effect.available) {
    issues.push({
      path: 'displayNameStyle.effect',
      message: `${effect.label} is not available for apps yet.`,
    });
  } else if (style.colours.length !== effect.colours) {
    const wanted = COLOUR_COUNT[effect.colours] ?? `${effect.colours} colours`;
    issues.push({
      path: 'displayNameStyle.colours',
      message: `${effect.label} takes ${wanted}, not ${style.colours.length}.`,
    });
  }

  return issues;
}

export function isSendableNameStyle(style: DisplayNameStyle | null): boolean {
  return nameStyleWriteIssues(style).length === 0;
}

export function toWireStyle(style: DisplayNameStyle | null): BotNameStyle | null {
  if (style === null) return null;

  return {
    fontId: NAME_STYLE_FONT_CATALOGUE[style.font].id,
    effectId: NAME_STYLE_EFFECT_CATALOGUE[style.effect].id,
    colours: [...style.colours],
  };
}

export function wireStyleFingerprint(style: BotNameStyle | null): string {
  if (style === null) return 'none';

  const colours = style.colours.map((value) => value.toString(36)).join('.');
  return `${style.fontId}-${style.effectId}-${colours}`;
}

export const hexColourSchema = z
  .string()
  .trim()
  .regex(/^#?[0-9a-f]{6}$/i)
  .transform((value) => Number.parseInt(value.replace('#', ''), 16));

export function parseHexColour(input: string): number | null {
  const parsed = hexColourSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function toHexColour(value: number): string {
  return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
}
