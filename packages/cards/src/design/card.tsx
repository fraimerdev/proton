import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { CardDescriptor, GoodbyeCard, RankCard, WelcomeCard } from '../descriptor.ts';
import { type PresetPalette, paletteFor } from '../presets.ts';
import { abbreviate, group, monogram, sanitiseText } from '../text.ts';
import {
  AVATAR_RING,
  AVATAR_SIZE,
  AVATAR_X,
  AVATAR_Y,
  BAR_HEIGHT,
  BAR_LEFT,
  BAR_TOP,
  BAR_WIDTH,
  baselineLift,
  CARD_HEIGHT,
  CARD_WIDTH,
  COLUMN_WIDTH,
  CONTENT_LEFT,
  CORNER_RADIUS,
  FONT_STACK,
  LINE_HEIGHT,
  mix,
  ROW_GAP,
  rowTop,
  withAlpha,
} from './tokens.ts';

export interface CardImages {
  avatarSrc?: string;

  backgroundSrc?: string;
}

export interface CardProps {
  card: CardDescriptor;
  images?: CardImages;
}

interface Skin extends PresetPalette {
  accent: string;
}

// A scrim changes the ground, so it has to change the ink with it: 68% of #0a0a0a over a bright
// photo composites near #3b3b3b, where the muted step falls under 3:1 and stops being readable.
function skinOf(card: CardDescriptor, backdrop: boolean): Skin {
  const palette = paletteFor(card.preset);

  return {
    ...palette,
    accent: card.accent ?? palette.accent,
    ...(backdrop ? { muted: mix(palette.muted, palette.text, 0.5) } : {}),
  };
}

const NAME_SIZE = 44;
const LEVEL_SIZE = 44;
const RANK_SIZE = 44;
const XP_SIZE = 28;
const PERCENT_SIZE = 30;
const EYEBROW_SIZE = 30;
const GREETING_NAME_SIZE = 52;
const GREETING_LINE_SIZE = 32;
const PILL_SIZE = 24;

// The original card set its two rows on these baselines, and the whole layout hangs off them.
const META_BASELINE = 80;
const ROW_BASELINE = 220;

const cover = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
} as const;

// A guild's own image is whatever they uploaded, and white text over a bright photo is unreadable.
// The scrim is what keeps every preset legible on top of any background.
const SCRIM_ALPHA = 0.68;

function Backdrop({ skin, src }: { skin: Skin; src: string | undefined }): ReactElement {
  return (
    <div style={{ ...cover, display: 'flex' }}>
      {src === undefined ? null : (
        <img
          alt=""
          height={CARD_HEIGHT}
          src={src}
          style={{ ...cover, objectFit: 'cover' }}
          width={CARD_WIDTH}
        />
      )}
      {src === undefined ? null : (
        <div
          style={{
            ...cover,
            display: 'flex',
            backgroundColor: withAlpha(skin.background, SCRIM_ALPHA),
          }}
        />
      )}
      <div
        style={{
          ...cover,
          display: 'flex',
          boxSizing: 'border-box',
          border: `1px solid ${skin.line}`,
          borderRadius: CORNER_RADIUS,
        }}
      />
    </div>
  );
}

function Avatar({
  skin,
  src,
  displayName,
}: {
  skin: Skin;
  src: string | undefined;
  displayName: string;
}): ReactElement {
  const inner = AVATAR_SIZE - AVATAR_RING * 2;

  return (
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        left: AVATAR_X,
        top: AVATAR_Y,
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        borderRadius: AVATAR_SIZE / 2,
        // Not white: the ring is white on every dark preset, but white on parchment is no ring.
        border: `${AVATAR_RING}px solid ${withAlpha(skin.text, 0.92)}`,
        backgroundColor: skin.accentSoft,
        overflow: 'hidden',
      }}
    >
      {src === undefined ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: inner,
            height: inner,
            fontSize: Math.round(inner * 0.42),
            fontWeight: 800,
            lineHeight: LINE_HEIGHT,
            color: skin.text,
          }}
        >
          {monogram(displayName)}
        </div>
      ) : (
        <img alt="" height={inner} src={src} style={{ objectFit: 'cover' }} width={inner} />
      )}
    </div>
  );
}

// text-overflow does not apply to the anonymous item a flex container wraps its text in, so Chrome
// hard-clips mid-glyph exactly where satori draws an ellipsis. The clip stays on the flex item —
// that is what lets it shrink below its own text — and the ellipsis goes on a block inside it.
function Clamped({ children, style }: { children: string; style: CSSProperties }): ReactElement {
  return (
    <div
      style={{
        display: 'block',
        width: '100%',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Frame({
  card,
  images,
  children,
}: {
  card: CardDescriptor;
  images: CardImages | undefined;
  children: ReactNode;
}): ReactElement {
  const skin = skinOf(card, images?.backgroundSrc !== undefined);

  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        boxSizing: 'border-box',
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        borderRadius: CORNER_RADIUS,
        overflow: 'hidden',
        backgroundColor: skin.background,
        fontFamily: FONT_STACK,
        color: skin.text,
      }}
    >
      <Backdrop skin={skin} src={images?.backgroundSrc} />
      <Avatar displayName={card.displayName} skin={skin} src={images?.avatarSrc} />
      {children}
    </div>
  );
}

function Row({
  baseline,
  largest,
  children,
}: {
  baseline: number;
  largest: number;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        position: 'absolute',
        left: CONTENT_LEFT,
        top: rowTop(baseline, largest),
        width: COLUMN_WIDTH,
        alignItems: 'flex-end',
        justifyContent: 'space-between',
      }}
    >
      {children}
    </div>
  );
}

function RankCardBody({
  card,
  images,
}: {
  card: RankCard;
  images: CardImages | undefined;
}): ReactElement {
  const skin = skinOf(card, images?.backgroundSrc !== undefined);
  const ratio = Math.min(1, Math.max(0, card.xpIntoLevel / card.xpForNextLevel));
  const rank = card.showRank && card.rank !== undefined ? abbreviate(card.rank) : null;

  // The round cap is the shape of the bar, not of the progress: below one cap-width the fill would
  // draw as a lens rather than a pill, which reads as a rendering fault instead of "barely started".
  const filled = ratio <= 0 ? 0 : Math.max(BAR_HEIGHT, Math.round(BAR_WIDTH * ratio));

  return (
    <Frame card={card} images={images}>
      <Row baseline={META_BASELINE} largest={RANK_SIZE}>
        <div
          style={{
            display: 'flex',
            marginBottom: baselineLift(RANK_SIZE, XP_SIZE),
            fontSize: XP_SIZE,
            fontWeight: 600,
            lineHeight: LINE_HEIGHT,
            color: skin.muted,
          }}
        >
          {card.showTotalXp ? `${group(card.totalXp)} XP` : ''}
        </div>

        {rank === null ? (
          <div style={{ display: 'flex' }} />
        ) : (
          <div style={{ display: 'flex', fontSize: RANK_SIZE, lineHeight: LINE_HEIGHT }}>
            <div style={{ display: 'flex', fontWeight: 400, color: skin.muted }}>Rank</div>
            <div style={{ display: 'flex', marginLeft: 14, fontWeight: 700, color: skin.accent }}>
              {rank}
            </div>
          </div>
        )}
      </Row>

      <Row baseline={ROW_BASELINE} largest={NAME_SIZE}>
        <div style={{ display: 'flex', flexShrink: 1, overflow: 'hidden' }}>
          <Clamped
            style={{
              fontSize: NAME_SIZE,
              fontWeight: 800,
              lineHeight: LINE_HEIGHT,
              color: skin.text,
            }}
          >
            {sanitiseText(card.displayName)}
          </Clamped>
        </div>

        <div
          style={{
            display: 'flex',
            flexShrink: 0,
            marginLeft: 32,
            fontSize: LEVEL_SIZE,
            fontWeight: 400,
            lineHeight: LINE_HEIGHT,
            color: skin.text,
          }}
        >
          {`Level ${group(card.level)}`}
        </div>
      </Row>

      <div
        style={{
          display: 'flex',
          position: 'absolute',
          left: BAR_LEFT,
          top: BAR_TOP,
          width: BAR_WIDTH,
          height: BAR_HEIGHT,
          borderRadius: BAR_HEIGHT / 2,
          backgroundColor: skin.track,
        }}
      />
      {filled === 0 ? null : (
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            left: BAR_LEFT,
            top: BAR_TOP,
            width: filled,
            height: BAR_HEIGHT,
            borderRadius: BAR_HEIGHT / 2,
            backgroundColor: skin.accent,
          }}
        />
      )}
      {card.showPercent ? (
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            left: BAR_LEFT,
            top: BAR_TOP,
            width: BAR_WIDTH,
            height: BAR_HEIGHT,
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: PERCENT_SIZE,
            fontWeight: 800,
            lineHeight: LINE_HEIGHT,
            color: skin.text,
          }}
        >
          {`${Math.floor(ratio * 100)}%`}
        </div>
      ) : null}
    </Frame>
  );
}

const GREETING_COPY = {
  welcome: {
    eyebrow: 'welcome',
    line: (guild: string) => `joined ${guild}`,
    tally: (count: number) => `Member #${group(count)}`,
  },
  goodbye: {
    eyebrow: 'goodbye',
    line: (guild: string) => `left ${guild}`,
    tally: (count: number) => (count === 1 ? '1 member remains' : `${group(count)} members remain`),
  },
} as const;

function GreetingCardBody({
  card,
  images,
}: {
  card: WelcomeCard | GoodbyeCard;
  images: CardImages | undefined;
}): ReactElement {
  const skin = skinOf(card, images?.backgroundSrc !== undefined);
  const copy = GREETING_COPY[card.kind];

  return (
    <Frame card={card} images={images}>
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          left: CONTENT_LEFT,
          top: 0,
          width: COLUMN_WIDTH,
          height: CARD_HEIGHT,
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            marginBottom: ROW_GAP,
            fontSize: EYEBROW_SIZE,
            fontWeight: 700,
            letterSpacing: 3.4,
            lineHeight: LINE_HEIGHT,
            textTransform: 'uppercase',
            color: skin.accent,
          }}
        >
          {copy.eyebrow}
        </div>

        <div
          style={{
            display: 'flex',
            width: COLUMN_WIDTH,
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', flexShrink: 1, overflow: 'hidden' }}>
            <Clamped
              style={{
                fontSize: GREETING_NAME_SIZE,
                fontWeight: 800,
                letterSpacing: -1,
                lineHeight: LINE_HEIGHT,
                color: skin.text,
              }}
            >
              {sanitiseText(card.displayName)}
            </Clamped>
          </div>

          {card.showMemberCount ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                marginLeft: 32,
                marginBottom: 6,
                boxSizing: 'border-box',
                height: 54,
                paddingLeft: 24,
                paddingRight: 24,
                borderRadius: 27,
                border: `1px solid ${withAlpha(skin.accent, 0.45)}`,
                backgroundColor: withAlpha(skin.accent, 0.12),
                fontSize: PILL_SIZE,
                fontWeight: 700,
                lineHeight: LINE_HEIGHT,
                color: skin.text,
              }}
            >
              {copy.tally(card.memberCount)}
            </div>
          ) : (
            <div style={{ display: 'flex' }} />
          )}
        </div>

        <div style={{ display: 'flex', overflow: 'hidden', width: COLUMN_WIDTH, marginTop: 8 }}>
          {/* The name, not the sentence: "joined " is always renderable, so sanitising the whole
              line can never reach the fallback and a non-latin guild name leaves a bare "joined". */}
          <Clamped
            style={{
              fontSize: GREETING_LINE_SIZE,
              fontWeight: 400,
              lineHeight: LINE_HEIGHT,
              color: skin.muted,
            }}
          >
            {copy.line(sanitiseText(card.guildName, 'this server'))}
          </Clamped>
        </div>
      </div>
    </Frame>
  );
}

export function Card({ card, images }: CardProps): ReactElement {
  return card.kind === 'rank' ? (
    <RankCardBody card={card} images={images} />
  ) : (
    <GreetingCardBody card={card} images={images} />
  );
}
