import type { BadgeIconId, BadgeShape } from '@proton/cards/design';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { LoadingArea } from '../ui/feedback.tsx';
import { Icon } from '../ui/icon.tsx';

export type CardKind = 'rank' | 'welcome' | 'goodbye' | 'badge';

export interface CardPreviewOptions {
  kind: CardKind;
  preset?: string | undefined;
  /** Discord's integer colour; serialised as the decimal string the route expects. */
  accent?: number | undefined;
  background?: string | undefined;
  showRank?: boolean | undefined;
  showPercent?: boolean | undefined;
  showTotalXp?: boolean | undefined;
  showMemberCount?: boolean | undefined;
  showBadges?: boolean | undefined;

  shape?: BadgeShape | undefined;
  icon?: BadgeIconId | undefined;
  colour?: number | undefined;
  assetId?: string | undefined;

  // Set by a simulation, which knows the real member and the real counts; left out by the settings
  // preview, where the route's own sample is what an admin wants to see.
  displayName?: string | undefined;
  guildName?: string | undefined;
  avatar?: string | undefined;
  memberCount?: number | undefined;
  level?: number | undefined;
  rank?: number | undefined;
  totalXp?: number | undefined;
  xpIntoLevel?: number | undefined;
  xpForNextLevel?: number | undefined;
}

function toQuery(options: CardPreviewOptions): string {
  const params = new URLSearchParams({ kind: options.kind });

  for (const [key, value] of Object.entries(options)) {
    if (key === 'kind' || value === undefined) continue;
    params.set(key, String(value));
  }

  return params.toString();
}

/**
 * The real PNG the bot posts, rendered by the same satori pipeline — not a CSS mock-up of it. The
 * request is debounced because every keystroke on the settings beside it would otherwise rasterise
 * a new card.
 */
export function CardPreview({
  guildId,
  options,
  alt = 'Card preview',
}: {
  guildId: string;
  options: CardPreviewOptions;
  alt?: string | undefined;
}): ReactElement {
  const query = useMemo(() => toQuery(options), [options]);

  const [src, setSrc] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;

    setLoading(true);
    const timer = window.setTimeout(() => {
      void fetch(`/api/guilds/${guildId}/card-preview?${query}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(await response.text());
          return response.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          url = URL.createObjectURL(blob);
          setSrc(url);
          setFailure(null);
        })
        .catch((error: Error) => {
          if (!cancelled) setFailure(error.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // Revoked on the next render rather than immediately: the <img> is still showing this blob
      // until the replacement decodes, and revoking early blanks the preview between edits.
      if (url) setTimeout(() => URL.revokeObjectURL(url as string), 1000);
    };
  }, [guildId, query]);

  if (failure !== null) {
    return (
      <div className="panel-sunken">
        <p className="text-sm text-muted">
          <Icon name="warning" size={14} weight="fill" className="text-warning" /> {failure}
        </p>
      </div>
    );
  }

  return (
    <div className="card-preview" data-loading={loading ? 'true' : undefined}>
      {src ? (
        <img src={src} alt={alt} />
      ) : (
        <div className="card-preview-pending">
          <LoadingArea label="Loading preview" minHeight={0} />
        </div>
      )}
    </div>
  );
}
