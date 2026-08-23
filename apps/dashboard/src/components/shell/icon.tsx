import type { ReactElement } from 'react';
import { ICONS, type IconName } from './icon-set.gen.ts';

export type IconWeight = 'regular' | 'fill';

export interface IconProps {
  name: IconName;
  weight?: IconWeight;
  className?: string | undefined;
}

// 1em square and currentColor, so an icon still takes its size from font-size and its colour from
// the text around it exactly as the webfont glyph it replaced did. The negative vertical-align is
// what the Phosphor stylesheet applied to its own <i>; without it an inline icon rides high.
export function Icon({ name, weight = 'regular', className }: IconProps): ReactElement {
  return (
    <svg
      viewBox="0 0 256 256"
      width="1em"
      height="1em"
      fill="currentColor"
      className={className}
      data-icon={name}
      style={{ verticalAlign: '-0.125em', flexShrink: 0 }}
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name][weight]} />
    </svg>
  );
}
