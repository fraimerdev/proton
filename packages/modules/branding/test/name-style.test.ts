import { describe, expect, test } from 'bun:test';
import { zodToDescriptors } from '@proton/core';
import {
  brandingConfigSchema,
  brandingDefaultConfig,
  brandingFormSchema,
  isBlank,
  liftStoredConfig,
} from '../src/config.ts';
import {
  type DisplayNameStyle,
  isEffectAvailable,
  isFontAvailable,
  isSendableNameStyle,
  NAME_STYLE_COLOURS,
  NAME_STYLE_EFFECT_CATALOGUE,
  NAME_STYLE_EFFECT_LABELS,
  NAME_STYLE_EFFECTS,
  NAME_STYLE_FONT_CATALOGUE,
  NAME_STYLE_FONT_LABELS,
  NAME_STYLE_FONTS,
  NAME_STYLE_UNAVAILABLE_NOTE,
  nameStyleWriteIssues,
  parseHexColour,
  sameDisplayNameStyle,
  sameWireStyle,
  toHexColour,
  toWireStyle,
  wireStyleFingerprint,
} from '../src/name-style.ts';

const RETIRED_DEFAULT: DisplayNameStyle = {
  font: 'gg-sans',
  effect: 'solid',
  colours: [0x2a8af7],
};

const GRADIENT: DisplayNameStyle = {
  font: 'modern',
  effect: 'gradient',
  colours: [0x5865f2, 0xeb459e],
};

function loads(style: unknown): boolean {
  return brandingConfigSchema.safeParse({ displayNameStyle: style }).success;
}

function storedStyle(raw: unknown): unknown {
  return (raw as { displayNameStyle?: unknown }).displayNameStyle;
}

describe('the display name style a server starts with', () => {
  test('is no style at all, which is not the same as choosing gg sans', () => {
    expect(brandingConfigSchema.parse({}).displayNameStyle).toBeNull();
    expect(brandingDefaultConfig.displayNameStyle).toBeNull();
  });

  test('fills in a config stored before the style existed and changes nothing else', () => {
    const stored = {
      enabled: true,
      nickname: 'Kestrel',
      restoreOnDisable: false,
      avatarHash: 'abc',
    } as const;

    const once = brandingConfigSchema.parse(stored);
    const { displayNameStyle, ...rest } = once;

    expect(displayNameStyle).toBeNull();
    expect(rest).toEqual(stored);
    expect(brandingConfigSchema.parse(once)).toEqual(once);
  });

  test('makes a server whose only setting is a style count as set up', () => {
    expect(isBlank(brandingDefaultConfig)).toBe(true);
    expect(isBlank({ ...brandingDefaultConfig, displayNameStyle: GRADIENT })).toBe(false);
  });
});

describe('the catalogue', () => {
  test('lists the fonts in Discord’s order, under Discord’s names, with their ids', () => {
    expect(
      NAME_STYLE_FONTS.map((font) => [
        NAME_STYLE_FONT_LABELS[font],
        NAME_STYLE_FONT_CATALOGUE[font].id,
      ]),
    ).toEqual([
      ['gg sans', 11],
      ['Tempo', 12],
      ['Sakura', 3],
      ['Jellybean', 4],
      ['Modern', 6],
      ['Medieval', 7],
      ['8Bit', 8],
      ['Vampyre', 10],
      ['Monkey Bars', 13],
      ['Mainframe', 14],
      ['Headbang', 15],
      ['Journal', 16],
    ]);
  });

  test('lists the effects in Discord’s order, with their ids and colour counts', () => {
    expect(
      NAME_STYLE_EFFECTS.map((effect) => [
        NAME_STYLE_EFFECT_LABELS[effect],
        NAME_STYLE_EFFECT_CATALOGUE[effect].id,
        NAME_STYLE_COLOURS[effect],
      ]),
    ).toEqual([
      ['Solid', 1, 1],
      ['Gradient', 2, 2],
      ['Neon', 3, 1],
      ['Toon', 4, 1],
      ['Pop', 5, 1],
      ['Gummy', 8, 4],
      ['Prism', 7, 5],
    ]);
  });

  test('offers exactly the fonts and effects Discord applied for Proton', () => {
    expect(NAME_STYLE_FONTS.filter((font) => isFontAvailable(font))).toEqual([
      'gg-sans',
      'tempo',
      'sakura',
      'jellybean',
      'modern',
      'medieval',
      '8bit',
      'vampyre',
    ]);
    expect(NAME_STYLE_EFFECTS.filter((effect) => isEffectAvailable(effect))).toEqual([
      'solid',
      'gradient',
      'neon',
      'toon',
      'pop',
    ]);
  });

  test('shows the rest as not available for apps yet', () => {
    expect(NAME_STYLE_FONTS.filter((font) => !isFontAvailable(font))).toEqual([
      'monkey-bars',
      'mainframe',
      'headbang',
      'journal',
    ]);
    expect(NAME_STYLE_EFFECTS.filter((effect) => !isEffectAvailable(effect))).toEqual([
      'gummy',
      'prism',
    ]);
    expect(NAME_STYLE_UNAVAILABLE_NOTE).toBe('Not available for apps yet');
  });

  test('never lists Glow, a deprecated font or a test effect, and gives no id twice', () => {
    const fontIds = Object.values(NAME_STYLE_FONT_CATALOGUE).map((entry) => entry.id);
    const effectIds = Object.values(NAME_STYLE_EFFECT_CATALOGUE).map((entry) => entry.id);

    expect(fontIds).not.toContain(1);
    expect(effectIds).not.toContain(6);
    expect(effectIds).not.toContain(1001);
    expect(Object.values(NAME_STYLE_EFFECT_LABELS)).not.toContain('Glow');
    expect(new Set(fontIds).size).toBe(fontIds.length);
    expect(new Set(effectIds).size).toBe(effectIds.length);
  });

  test('stores Proton’s own slugs, none of which could pass for a Discord id', () => {
    for (const slug of [...NAME_STYLE_FONTS, ...NAME_STYLE_EFFECTS]) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(Number.isNaN(Number(slug))).toBe(true);
    }
  });
});

describe('reading a stored style', () => {
  test('loads a style Discord no longer offers or with the wrong colour count, never failing', () => {
    const stored: Array<DisplayNameStyle | null> = [
      { font: 'monkey-bars', effect: 'solid', colours: [0] },
      { font: 'gg-sans', effect: 'prism', colours: [1, 2, 3, 4, 5] },
      { font: 'tempo', effect: 'gradient', colours: [0xffffff] },
      { font: 'tempo', effect: 'solid', colours: [] },
      null,
    ];

    for (const style of stored) {
      expect(brandingConfigSchema.parse({ displayNameStyle: style }).displayNameStyle).toEqual(
        style,
      );
    }
  });

  test('takes colours from 000000 to FFFFFF inclusive', () => {
    expect(loads({ font: 'gg-sans', effect: 'solid', colours: [0] })).toBe(true);
    expect(loads({ font: 'gg-sans', effect: 'solid', colours: [0xffffff] })).toBe(true);
  });

  test('the schema alone refuses a colour that is not a whole number from 000000 to FFFFFF', () => {
    for (const bad of [0x1000000, -1, 1.5, '#ffffff']) {
      expect(loads({ font: 'gg-sans', effect: 'solid', colours: [bad] })).toBe(false);
    }
  });

  test('the schema alone refuses an unknown font, an unknown effect and more than five colours', () => {
    expect(loads({ font: 'comic', effect: 'solid', colours: [0] })).toBe(false);
    expect(loads({ font: 'gg-sans', effect: 'glow', colours: [0] })).toBe(false);
    expect(loads({ font: 'gg-sans', effect: 'prism', colours: [0, 1, 2, 3, 4, 5] })).toBe(false);
  });
});

describe('the rules a changed style must meet before it is saved', () => {
  test('accept no style, and every offered font and effect with its colour count, zero included', () => {
    expect(nameStyleWriteIssues(null)).toEqual([]);

    for (const font of NAME_STYLE_FONTS.filter((slug) => isFontAvailable(slug))) {
      for (const effect of NAME_STYLE_EFFECTS.filter((slug) => isEffectAvailable(slug))) {
        const colours = Array.from({ length: NAME_STYLE_COLOURS[effect] }, () => 0);
        expect(nameStyleWriteIssues({ font, effect, colours })).toEqual([]);
      }
    }
  });

  test('name the effect and how many colours it takes when the count is wrong', () => {
    const gradient = nameStyleWriteIssues({ font: 'tempo', effect: 'gradient', colours: [1] });
    const solid = nameStyleWriteIssues({ font: 'tempo', effect: 'solid', colours: [0, 1] });
    const neon = nameStyleWriteIssues({ font: 'tempo', effect: 'neon', colours: [] });

    expect([...gradient, ...solid, ...neon]).toEqual([
      { path: 'displayNameStyle.colours', message: 'Gradient takes two colours, not 1.' },
      { path: 'displayNameStyle.colours', message: 'Solid takes one colour, not 2.' },
      { path: 'displayNameStyle.colours', message: 'Neon takes one colour, not 0.' },
    ]);
  });

  test('refuse a font or an effect Discord does not apply for apps yet, by name', () => {
    const issues = nameStyleWriteIssues({
      font: 'monkey-bars',
      effect: 'prism',
      colours: [1, 2, 3, 4, 5],
    });

    expect(issues).toEqual([
      { path: 'displayNameStyle.font', message: 'Monkey Bars is not available for apps yet.' },
      { path: 'displayNameStyle.effect', message: 'Prism is not available for apps yet.' },
    ]);
    expect(isSendableNameStyle({ font: 'journal', effect: 'solid', colours: [0] })).toBe(false);
    expect(isSendableNameStyle({ font: 'journal', effect: 'solid', colours: [0] })).toBe(false);
    expect(isSendableNameStyle(GRADIENT)).toBe(true);
    expect(isSendableNameStyle(null)).toBe(true);
  });

  test('never put a semicolon in a message, because the API joins issues with one', () => {
    const messages = [
      ...NAME_STYLE_FONTS.map((font) => ({ font, effect: 'solid' as const, colours: [] })),
      ...NAME_STYLE_EFFECTS.map((effect) => ({ font: 'journal' as const, effect, colours: [] })),
    ].flatMap((style) => nameStyleWriteIssues(style).map((issue) => issue.message));

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message).not.toContain(';');
  });
});

describe('the style Proton sends to Discord', () => {
  test('turns slugs into Discord ids and keeps the colours in order', () => {
    expect(toWireStyle(GRADIENT)).toEqual({
      fontId: 6,
      effectId: 2,
      colours: [0x5865f2, 0xeb459e],
    });
    expect(toWireStyle(null)).toBeNull();
  });

  test('copies the colours, so changing the request never changes the config', () => {
    const style: DisplayNameStyle = { font: 'tempo', effect: 'solid', colours: [1] };

    toWireStyle(style)?.colours.push(2);

    expect(style.colours).toEqual([1]);
  });

  test('counts the same colours in another order as another style', () => {
    const swapped = { ...GRADIENT, colours: [0xeb459e, 0x5865f2] };

    expect(sameDisplayNameStyle(GRADIENT, swapped)).toBe(false);
    expect(sameDisplayNameStyle(GRADIENT, { ...GRADIENT, colours: [...GRADIENT.colours] })).toBe(
      true,
    );
    expect(sameDisplayNameStyle(null, null)).toBe(true);
    expect(sameDisplayNameStyle(null, GRADIENT)).toBe(false);

    expect(sameWireStyle(toWireStyle(GRADIENT), toWireStyle(swapped))).toBe(false);
    expect(sameWireStyle(toWireStyle(GRADIENT), toWireStyle(GRADIENT))).toBe(true);
    expect(sameWireStyle(null, null)).toBe(true);
    expect(sameWireStyle(null, toWireStyle(GRADIENT))).toBe(false);
  });

  test('fingerprints the same style the same way and every other style differently', () => {
    const swapped = toWireStyle({ ...GRADIENT, colours: [0xeb459e, 0x5865f2] });

    expect(wireStyleFingerprint(toWireStyle(GRADIENT))).toBe(
      wireStyleFingerprint(toWireStyle(GRADIENT)),
    );
    expect(wireStyleFingerprint(toWireStyle(GRADIENT))).not.toBe(wireStyleFingerprint(swapped));
    expect(wireStyleFingerprint(null)).not.toBe(wireStyleFingerprint(toWireStyle(GRADIENT)));
  });
});

describe('lifting a row saved by the preview-only build', () => {
  test('reads that build’s default style as no style', () => {
    const lifted = liftStoredConfig({
      enabled: true,
      nickname: 'Kestrel',
      displayNameStyle: RETIRED_DEFAULT,
    });

    expect(brandingConfigSchema.parse(lifted)).toMatchObject({
      enabled: true,
      nickname: 'Kestrel',
      displayNameStyle: null,
    });
  });

  test('keeps that same style when an admin saves it, and reads it back as chosen', () => {
    const written = brandingConfigSchema.parse(
      liftStoredConfig({ displayNameStyle: RETIRED_DEFAULT }, {}),
    );

    expect(written.displayNameStyle).toEqual(RETIRED_DEFAULT);
    expect(written.nameStyleNative).toBe(true);
    expect(brandingConfigSchema.parse(liftStoredConfig(written)).displayNameStyle).toEqual(
      RETIRED_DEFAULT,
    );
  });

  test('loads every other stored style unchanged', () => {
    for (const style of [
      GRADIENT,
      { font: 'gg-sans', effect: 'solid', colours: [0x2a8af8] },
      { font: 'gg-sans', effect: 'neon', colours: [0x2a8af7] },
      { font: 'tempo', effect: 'solid', colours: [0x2a8af7] },
      { font: 'gg-sans', effect: 'solid', colours: [0x2a8af7, 0x2a8af7] },
      { font: 'monkey-bars', effect: 'solid', colours: [0x2a8af7] },
      { font: 'journal', effect: 'prism', colours: [1, 2, 3, 4, 5] },
      { font: 'tempo', effect: 'gradient', colours: [0xffffff] },
      { font: 'tempo', effect: 'solid', colours: [] },
      null,
    ]) {
      expect(storedStyle(liftStoredConfig({ displayNameStyle: style }))).toEqual(style);
    }

    expect(liftStoredConfig({ nickname: 'Kestrel' })).toEqual({ nickname: 'Kestrel' });
  });

  test('reads a stored style Proton cannot parse as no style, keeping every other setting', () => {
    const unreadable: unknown[] = [
      'garbage',
      42,
      { font: 'comic', effect: 'solid', colours: [0] },
      { font: 'gg-sans', effect: 'prism', colours: [0, 1, 2, 3, 4, 5] },
      { font: 'gg-sans', effect: 'solid', colours: [16777216] },
    ];

    for (const style of unreadable) {
      for (const stamp of [{}, { nameStyleNative: true }]) {
        const stored = { enabled: true, nickname: 'Kestrel', displayNameStyle: style, ...stamp };

        expect(brandingConfigSchema.safeParse(stored).success).toBe(false);
        expect(brandingConfigSchema.parse(liftStoredConfig(stored))).toMatchObject({
          enabled: true,
          nickname: 'Kestrel',
          displayNameStyle: null,
        });
      }
    }
  });

  test('still refuses a style Proton cannot parse when an admin saves it', () => {
    for (const style of ['garbage', { font: 'comic', effect: 'solid', colours: [0] }]) {
      const written = liftStoredConfig({ enabled: true, displayNameStyle: style }, {});

      expect(brandingConfigSchema.safeParse(written).success).toBe(false);
    }
  });

  test('changes nothing on a second read', () => {
    const once = liftStoredConfig({ enabled: true, displayNameStyle: RETIRED_DEFAULT });

    expect(liftStoredConfig(once)).toEqual(once);
  });

  test('still drops the retired keys on a write, and stamps the row', () => {
    expect(liftStoredConfig({ nickname: 'Kestrel', avatarUrl: 'x', typeface: 'bold' }, {})).toEqual(
      { nickname: 'Kestrel', nameStyleNative: true },
    );
  });
});

describe('the settings form', () => {
  test('builds a field for each part of the style, so boot and search still see it', () => {
    const fields = new Map(
      zodToDescriptors(brandingFormSchema).map((field) => [field.path, field]),
    );

    expect(fields.get('displayNameStyle.font')).toMatchObject({
      kind: 'enum',
      label: 'Display name font',
      options: [...NAME_STYLE_FONTS],
    });
    expect(fields.get('displayNameStyle.effect')).toMatchObject({
      kind: 'enum',
      label: 'Display name effect',
      options: [...NAME_STYLE_EFFECTS],
    });
    expect(fields.get('displayNameStyle.colours')).toMatchObject({
      kind: 'colour',
      label: 'Display name colours',
      array: true,
      maxItems: 5,
    });
  });

  test('offers no field for the stamp the API writes', () => {
    expect(Object.keys(brandingFormSchema.shape)).not.toContain('nameStyleNative');
  });
});

describe('typing a colour as hex', () => {
  test('takes six digits with or without the hash, in either case, around spaces', () => {
    expect(parseHexColour('#0ab9fe')).toBe(0x0ab9fe);
    expect(parseHexColour('0AB9FE')).toBe(0x0ab9fe);
    expect(parseHexColour(' #0ab9fe ')).toBe(0x0ab9fe);
  });

  test('refuses anything that is not exactly six hex digits', () => {
    for (const bad of ['#fff', '#12345g', '', '#0ab9fe0', '##0ab9fe', '0x0ab9fe']) {
      expect(parseHexColour(bad)).toBeNull();
    }
  });

  test('writes a stored colour back as upper-case hex, keeping its leading zeros', () => {
    expect(toHexColour(0x0ab9fe)).toBe('#0AB9FE');
    expect(toHexColour(0)).toBe('#000000');
    expect(parseHexColour(toHexColour(0x2a8af7))).toBe(0x2a8af7);
  });
});
