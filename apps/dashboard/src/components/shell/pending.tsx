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

// The router's default, which renders straight into the root outlet with no shell around it. It
// has the whole viewport to centre in; Spinner is sized for a panel that already has a page on it.
export function RoutePending(): ReactElement {
  return (
    <div className="route-pending route-pending-page" role="status">
      <span className="spinner" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
