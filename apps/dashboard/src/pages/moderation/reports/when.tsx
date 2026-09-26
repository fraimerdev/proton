import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react';
import { useHydrated } from '../../../components/ui/overlay.tsx';
import { relativeTime } from './queue-labels.ts';

const MINUTE_MS = 60_000;

const unsubscribed = (): (() => void) => () => undefined;

export function useNow(fetchedAt: number): number {
  const hydrated = useHydrated();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Not Date.now() while hydrating: the server may have read another minute, and React throws.
  return hydrated ? now : fetchedAt;
}

export function useLocalTime(at: number | null): string | undefined {
  // The server renders in its own time zone; the viewer's is only known once hydrated.
  return useSyncExternalStore(
    unsubscribed,
    () => (at === null ? undefined : new Date(at).toLocaleString()),
    () => undefined,
  );
}

export function useLocalDate(at: number | null): string | undefined {
  return useSyncExternalStore(
    unsubscribed,
    () =>
      at === null
        ? undefined
        : new Date(at).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
    () => undefined,
  );
}

export function When({
  at,
  now,
  prefix,
}: {
  at: number | null;
  now: number;
  prefix?: string | undefined;
}): ReactElement {
  const title = useLocalTime(at);

  if (at === null) return <span className="text-muted">Never</span>;

  return (
    <time dateTime={new Date(at).toISOString()} title={title}>
      {prefix}
      {relativeTime(at, now)}
    </time>
  );
}
