import type { ReactElement } from 'react';
import { LoadingArea } from './feedback.tsx';

export function RoutePending(): ReactElement {
  return (
    <div className="page">
      <LoadingArea size="lg" minHeight="60vh" fallback />
    </div>
  );
}
