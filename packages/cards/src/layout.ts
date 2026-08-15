import type { CardDescriptor, GoodbyeCard, RankCard, WelcomeCard } from './descriptor.ts';
import { FONT_FAMILY } from './fonts.ts';
import { type PresetPalette, paletteFor } from './presets.ts';

/**
 * The node shape satori consumes.
 *
 * Declared here rather than imported because satori types its element parameter
 * as React's `ReactNode` — pulling `@types/react` into a package that renders
 * PNGs on a server would be a dependency taken for a type alias. These four
 * fields are the whole of what satori reads from a node.
 */
export interface CardNode {
  type: 'div' | 'img';
  props: {
    style: Record<string, string | number>;
    children?: CardNode | CardNode[] | string;
    src?: string;
  };
}

/**
 * The code points the embedded latin subset can actually draw.
 *
 * `@fontsource/inter`'s `unicode.json` `latin` range — Google Fonts' own subset
 * definition for the exact files in `assets/` — with one deliberate narrowing:
 * that range starts at U+0000, and this starts at U+0020, because C0 control
 * characters are not glyphs and a name is not improved by carrying a U+0007
 * through to the renderer. Written as escapes rather than literal characters so
 * the set stays auditable against `unicode.json` without trusting an editor to
 * render combining marks and a BOM legibly.
 */
const RENDERABLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: these are code points, not grapheme clusters. The combining marks (U+0304, U+0308, U+0329) are members of the font's subset in their own right and are meant to match individually.
  /[ -ÿıŒ-œʻ-ʼˆ˚˜̩̄̈ -⁯€™↑↓−∕﻿�]/u;

/** Shown when a name consists entirely of glyphs the subset cannot draw. */
const UNRENDERABLE_NAME = 'Member';

/**
 * Drop what the font cannot draw, rather than letting satori emit .notdef boxes.
 *
 * satori does not throw on a missing glyph — verified — it silently renders
 * nothing, so a CJK or emoji username would otherwise produce a card with a row
 * of blanks where the name should be, which reads as a rendering bug. Dropping is
 * the lesser evil and is not the only line of defence: `@proton/module-welcome`
 * always sends its text message alongside the card, and Discord renders the
 * member's real name there in the client's own fonts. The card is the decoration;
 * the message is the content.
 *
 * The real fix is a CJK-capable fallback face, which is several megabytes of
 * binary in git and a deliberate decision for whoever owns i18n — not something
 * to smuggle in behind a card.
 */
export function sanitiseText(input: string, fallback = UNRENDERABLE_NAME): string {
  const kept = [...input].filter((char) => RENDERABLE.test(char)).join('');
  // Control characters and stray whitespace survive the range test above; a name
  // is one line, so they collapse rather than reflowing the layout.
  const collapsed = kept.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

/** The letter drawn when there is no avatar bitmap to draw. */
export function monogram(displayName: string): string {
  const first = [...sanitiseText(displayName, '')].find((char) => /[\p{L}\p{N}]/u.test(char));
  return (first ?? '?').toUpperCase();
}

/** `1234` → `1,234`. Card numbers are read at a glance, so they get separators. */
function group(value: number): string {
  return value.toLocaleString('en-US');
}

function text(value: string, style: Record<string, string | number>): CardNode {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: value } };
}

/**
 * The avatar, or a monogram standing in for it.
 *
 * One function for both so the ring, the diameter and the circle geometry cannot
 * drift between the two cases — a fallback that is a different size from the
 * thing it replaces makes a CDN blip visible as a layout shift.
 */
function avatar(
  dataUri: string | null,
  displayName: string,
  size: number,
  palette: PresetPalette,
): CardNode {
  const frame = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: `${size / 2}px`,
    border: `4px solid ${palette.accent}`,
  };

  if (dataUri) {
    // `objectFit: cover` so a non-square avatar is cropped rather than squashed.
    return { type: 'img', props: { src: dataUri, style: { ...frame, objectFit: 'cover' } } };
  }

  return {
    type: 'div',
    props: {
      style: {
        ...frame,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: palette.accentSoft,
        color: palette.text,
        fontSize: `${Math.round(size * 0.42)}px`,
        fontWeight: 700,
      },
      children: monogram(displayName),
    },
  };
}

function root(
  palette: PresetPalette,
  extra: Record<string, string | number>,
): Record<string, string | number> {
  return {
    display: 'flex',
    width: '100%',
    height: '100%',
    backgroundColor: palette.background,
    color: palette.text,
    fontFamily: FONT_FAMILY,
    ...extra,
  };
}

function rankLayout(card: RankCard, dataUri: string | null): CardNode {
  const palette = paletteFor(card.preset);
  // Clamped rather than trusted: the schema refuses a numerator above its
  // denominator, but a bar drawn from a percentage is one arithmetic slip away
  // from overflowing its track, and a card is not worth a crash.
  const ratio = Math.min(1, Math.max(0, card.xpIntoLevel / card.xpForNextLevel));

  const header: CardNode = {
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
      children: [
        text(sanitiseText(card.displayName), { fontSize: '40px', fontWeight: 700 }),
        ...(card.rank === undefined
          ? []
          : [
              text(`#${group(card.rank)}`, {
                fontSize: '34px',
                fontWeight: 700,
                color: palette.accent,
              }),
            ]),
      ],
    },
  };

  const meta: CardNode = {
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
      children: [
        text(`LEVEL ${group(card.level)}`, {
          fontSize: '24px',
          fontWeight: 700,
          letterSpacing: '2px',
          color: palette.accent,
        }),
        text(`${group(card.xpIntoLevel)} / ${group(card.xpForNextLevel)} XP`, {
          fontSize: '22px',
          color: palette.muted,
        }),
      ],
    },
  };

  const progress: CardNode = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: '100%',
        height: '22px',
        borderRadius: '11px',
        backgroundColor: palette.surface,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              // A zero-width fill is a rounded sliver of colour rather than
              // nothing, which reads as "no progress" instead of "bar missing".
              width: `${Math.max(2, ratio * 100)}%`,
              height: '100%',
              borderRadius: '11px',
              backgroundColor: palette.accent,
            },
          },
        },
      ],
    },
  };

  return {
    type: 'div',
    props: {
      style: root(palette, { alignItems: 'center', padding: '32px' }),
      children: [
        avatar(dataUri, card.displayName, 152, palette),
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1,
              marginLeft: '32px',
              // Total XP sits below the bar; the gap does the vertical rhythm so
              // no child carries a margin that a reorder would strand.
              gap: '14px',
            },
            children: [
              header,
              meta,
              progress,
              text(`${group(card.totalXp)} XP total`, {
                fontSize: '20px',
                color: palette.muted,
              }),
            ],
          },
        },
      ],
    },
  };
}

/**
 * Welcome and goodbye are one layout with two sets of words (§3.C: "same shape,
 * different copy"), so the copy is a table and the geometry is written once. A
 * second near-identical layout function is how the two silently drift apart.
 */
const GREETING_COPY = {
  welcome: {
    eyebrow: 'WELCOME',
    line: (guild: string) => `joined ${guild}`,
    tally: (count: number) => `Member #${group(count)}`,
  },
  goodbye: {
    eyebrow: 'GOODBYE',
    line: (guild: string) => `left ${guild}`,
    tally: (count: number) => (count === 1 ? '1 member remains' : `${group(count)} members remain`),
  },
} as const;

function greetingLayout(card: WelcomeCard | GoodbyeCard, dataUri: string | null): CardNode {
  const palette = paletteFor(card.preset);
  const copy = GREETING_COPY[card.kind];

  return {
    type: 'div',
    props: {
      style: root(palette, {
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '28px',
        gap: '10px',
      }),
      children: [
        avatar(dataUri, card.displayName, 116, palette),
        text(copy.eyebrow, {
          fontSize: '20px',
          fontWeight: 700,
          letterSpacing: '5px',
          color: palette.accent,
        }),
        text(sanitiseText(card.displayName), { fontSize: '42px', fontWeight: 700 }),
        text(sanitiseText(copy.line(card.guildName), copy.line('this server')), {
          fontSize: '24px',
          color: palette.muted,
        }),
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              padding: '8px 20px',
              borderRadius: '999px',
              backgroundColor: palette.surface,
              color: palette.text,
              fontSize: '20px',
              fontWeight: 700,
            },
            children: copy.tally(card.memberCount),
          },
        },
      ],
    },
  };
}

/**
 * Build the node tree for any card.
 *
 * `dataUri` is resolved by the caller rather than fetched here, so this whole
 * file is pure: same descriptor and same avatar bytes give the same tree, which
 * is what makes the rendered PNG assertable byte-for-byte in CI.
 */
export function buildLayout(card: CardDescriptor, dataUri: string | null): CardNode {
  switch (card.kind) {
    case 'rank':
      return rankLayout(card, dataUri);
    case 'welcome':
    case 'goodbye':
      return greetingLayout(card, dataUri);
  }
}
