import type { ReactElement } from 'react';
import {
  BADGE_CARD_SIZE,
  BADGE_ICON_PATHS,
  BADGE_SHAPE_PATHS,
  type BadgeIconId,
  type BadgeShape,
} from './badges.ts';
import { mix } from './tokens.ts';

export interface BadgeArtProps {
  shape: BadgeShape;
  colour: string;
  icon?: BadgeIconId | undefined;
  image?: string | undefined;
  size: number;
  label?: string | undefined;
}

const RIM_SHADE = 0.25;

const FACE = 'translate(16 16) scale(0.875)';

const FACE_CLIPS: Record<BadgeShape, string> = {
  circle: 'circle(41.02% at 50% 50%)',
  shield:
    'polygon(22.66% 11.72%, 77.34% 11.72%, 80.48% 12.34%, 83.14% 14.12%, 84.92% 16.78%, 85.55% 19.92%, 85.55% 45.9%, 84.69% 54.17%, 82.3% 61.58%, 78.63% 68.15%, 73.93% 73.93%, 68.46% 78.93%, 62.48% 83.2%, 56.24% 86.76%, 50% 89.65%, 43.76% 86.76%, 37.52% 83.2%, 31.54% 78.93%, 26.07% 73.93%, 21.37% 68.15%, 17.7% 61.58%, 15.31% 54.17%, 14.45% 45.9%, 14.45% 19.92%, 15.55% 15.82%, 18.55% 12.82%)',
  hexagon:
    'polygon(44.08% 11.72%, 47.04% 10.44%, 50% 10.01%, 52.96% 10.44%, 55.92% 11.72%, 80.19% 25.73%, 82.78% 27.66%, 84.63% 30%, 85.74% 32.78%, 86.11% 35.99%, 86.11% 64.01%, 85.74% 67.22%, 84.63% 70%, 82.78% 72.34%, 80.19% 74.27%, 55.92% 88.28%, 52.96% 89.56%, 50% 89.99%, 47.04% 89.56%, 44.08% 88.28%, 19.81% 74.27%, 17.22% 72.34%, 15.37% 70%, 14.26% 67.22%, 13.89% 64.01%, 13.89% 35.99%, 14.26% 32.78%, 15.37% 30%, 17.22% 27.66%, 19.81% 25.73%)',
  square: 'inset(11.72% round 16.41%)',
};

const ICON_TOP: Record<BadgeShape, number> = { circle: 64, shield: 52, hexagon: 64, square: 64 };

const LIGHT_INK = '#ffffff';
const DARK_INK = '#16181d';

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r = 0, g = 0, b = 0] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map(
    (channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    },
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function inkOn(face: string): string {
  return 1.05 / (luminance(face) + 0.05) >= 3 ? LIGHT_INK : DARK_INK;
}

// The image is an <img> over the <svg> rather than an <image> inside it: satori preloads an svg's
// images only when the <svg> is written out at the root of the tree, never inside a component.
export function BadgeArt({ shape, colour, icon, image, size, label }: BadgeArtProps): ReactElement {
  const outline = BADGE_SHAPE_PATHS[shape];
  const described =
    label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };

  return (
    <div
      style={{ display: 'flex', position: 'relative', flexShrink: 0, width: size, height: size }}
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: labelled or hidden through the spread, which keeps satori from writing attributes that say "undefined" */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${BADGE_CARD_SIZE} ${BADGE_CARD_SIZE}`}
        {...described}
      >
        <path d={outline} fill={mix(colour, '#000000', RIM_SHADE)} />
        <path d={outline} fill={colour} transform={FACE} />
        {image === undefined && icon !== undefined ? (
          <path
            d={BADGE_ICON_PATHS[icon]}
            fill={inkOn(colour)}
            transform={`translate(64 ${ICON_TOP[shape]}) scale(0.5)`}
          />
        ) : null}
      </svg>
      {image === undefined ? null : (
        <img
          alt=""
          height={size}
          src={image}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: size,
            height: size,
            objectFit: 'cover',
            clipPath: FACE_CLIPS[shape],
          }}
          width={size}
        />
      )}
    </div>
  );
}
