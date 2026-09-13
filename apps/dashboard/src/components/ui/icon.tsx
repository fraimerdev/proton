import type { ReactElement } from 'react';
import { ICONS, type IconName, type IconWeight } from './icon-set.gen.ts';

export type { IconName, IconWeight };

interface IconProps {
  name: IconName;
  weight?: IconWeight;
  size?: number;
  className?: string | undefined;
  /** Give a label only when the icon is the whole control; otherwise it stays hidden from AT. */
  label?: string;
}

export function Icon({
  name,
  weight = 'regular',
  size = 16,
  className,
  label,
}: IconProps): ReactElement {
  const paths = ICONS[name][weight];

  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
