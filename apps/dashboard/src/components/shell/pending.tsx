import type { ReactElement } from 'react';

// role=status with the word offscreen, because the ring itself says nothing to a screen reader and
// a page that is still arriving has to announce that it is.
export function Spinner(): ReactElement {
  return (
    <div className="route-pending" role="status">
      <span className="spinner" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
