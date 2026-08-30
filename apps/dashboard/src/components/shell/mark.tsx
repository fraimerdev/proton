import type { ReactElement } from 'react';

// Its own module so the public pages can draw the mark without pulling the whole signed-in shell —
// the rail, the palette and the guild menus — into the bundle of a page nobody has signed into.
export function ProtonMark({ size = 28 }: { size?: number }): ReactElement {
  return (
    <img
      src="/proton-mark.png"
      alt=""
      width={size}
      height={size}
      decoding="async"
      loading="lazy"
      style={{ display: 'block' }}
    />
  );
}
