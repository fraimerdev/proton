import type { CardDescriptor, GoodbyeCard, RankCard, WelcomeCard } from './descriptor.ts';
import { FONT_FAMILY } from './fonts.ts';
import { type PresetPalette, paletteFor } from './presets.ts';

export interface CardNode {
  type: 'div' | 'img';
  props: {
    style: Record<string, string | number>;
    children?: CardNode | CardNode[] | string;
    src?: string;
  };
}

const RENDERABLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: these are code points, not grapheme clusters. The combining marks (U+0304, U+0308, U+0329) are members of the font's subset in their own right and are meant to match individually.
  /[ -ÿıŒ-œʻ-ʼˆ˚˜̩̄̈ -⁯€™↑↓−∕﻿�]/u;

const UNRENDERABLE_NAME = 'Member';

export function sanitiseText(input: string, fallback = UNRENDERABLE_NAME): string {
  const kept = [...input].filter((char) => RENDERABLE.test(char)).join('');

  const collapsed = kept.replace(/\s+/gu, ' ').trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

export function monogram(displayName: string): string {
  const first = [...sanitiseText(displayName, '')].find((char) => /[\p{L}\p{N}]/u.test(char));
  return (first ?? '?').toUpperCase();
}

function group(value: number): string {
  return value.toLocaleString('en-US');
}

function text(value: string, style: Record<string, string | number>): CardNode {
  return { type: 'div', props: { style: { display: 'flex', ...style }, children: value } };
}

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

export function buildLayout(card: CardDescriptor, dataUri: string | null): CardNode {
  switch (card.kind) {
    case 'rank':
      return rankLayout(card, dataUri);
    case 'welcome':
    case 'goodbye':
      return greetingLayout(card, dataUri);
  }
}
