import {
  CARD_HEIGHT,
  CARD_PRESETS,
  CARD_WIDTH,
  Card,
  type CardDescriptorInput,
  type CardImages,
  type CardPreset,
  cardDescriptorSchema,
  cardImageHostAllowed,
  PREVIEW_SAMPLE,
  toHexColour,
} from '@proton/cards/design';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, type RefObject, useEffect, useRef, useState } from 'react';
import { sessionQuery } from '../../lib/queries.ts';

// The card is authored at its real 1100x370 and scaled down to whatever the settings column gives
// it, rather than re-laid-out at panel width: this is the same component the bot renders through
// satori, so anything responsive here would be a picture of a card Discord never receives.
const SSR_SCALE = 0.5;

function useFittedScale(): [RefObject<HTMLDivElement | null>, number] {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(SSR_SCALE);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setScale(width / CARD_WIDTH);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [frame, scale];
}

// The bot fetches card images through HttpImageFetcher and hands satori a data: URI, so a host it
// refuses or a dead URL reaches the renderer as "no image" and the card falls back. A browser would
// instead paint a broken <img> and, worse, the scrim and lifted ink that come with having a
// background at all — so the preview applies the same host rule and waits for the load. It still
// cannot see the byte cap or the content-type allowlist: an image too big or in the wrong format
// shows here and is dropped from the PNG.
function useLoadedImage(url: string | undefined): string | undefined {
  const [loaded, setLoaded] = useState<string | undefined>(undefined);
  const allowed = url !== undefined && cardImageHostAllowed(url) ? url : undefined;

  useEffect(() => {
    setLoaded(undefined);
    if (allowed === undefined) return;

    const probe = new Image();
    probe.onload = () => setLoaded(allowed);
    probe.src = allowed;

    return () => {
      probe.onload = null;
    };
  }, [allowed]);

  return loaded;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function presetOf(value: unknown): CardPreset | undefined {
  return CARD_PRESETS.find((preset) => preset === value);
}

function useCardImages(config: Record<string, unknown>, avatarUrl: string | undefined): CardImages {
  const avatarSrc = useLoadedImage(avatarUrl);
  const backgroundSrc = useLoadedImage(text(config.cardBackgroundUrl));

  return {
    ...(avatarSrc === undefined ? {} : { avatarSrc }),
    ...(backgroundSrc === undefined ? {} : { backgroundSrc }),
  };
}

function shared(config: Record<string, unknown>, presetKey: string) {
  const preset = presetOf(config[presetKey]);
  const accent = config.cardAccent;
  const background = text(config.cardBackgroundUrl);

  return {
    ...(preset ? { preset } : {}),
    ...(typeof accent === 'number' ? { accent: toHexColour(accent) } : {}),
    ...(background ? { backgroundUrl: background } : {}),
  };
}

function rankDescriptor(config: Record<string, unknown>, displayName: string): CardDescriptorInput {
  return {
    kind: 'rank',
    displayName,
    ...shared(config, 'cardPreset'),
    level: PREVIEW_SAMPLE.level,
    rank: PREVIEW_SAMPLE.rank,
    totalXp: PREVIEW_SAMPLE.totalXp,
    xpIntoLevel: PREVIEW_SAMPLE.xpIntoLevel,
    xpForNextLevel: PREVIEW_SAMPLE.xpForNextLevel,
    showRank: flag(config.cardShowRank, true),
    showPercent: flag(config.cardShowPercent, true),
    showTotalXp: flag(config.cardShowTotalXp, true),
  };
}

function greetingDescriptor(
  kind: 'welcome' | 'goodbye',
  config: Record<string, unknown>,
  displayName: string,
  guildName: string,
): CardDescriptorInput {
  return {
    kind,
    displayName,
    guildName,
    ...shared(config, 'preset'),
    memberCount: PREVIEW_SAMPLE.memberCount,
    showMemberCount: flag(config.cardShowMemberCount, true),
  };
}

interface CardPreviewProps {
  descriptor: CardDescriptorInput;
  images?: CardImages;
}

function CardPreview({ descriptor, images }: CardPreviewProps): ReactElement {
  const [frame, scale] = useFittedScale();
  const parsed = cardDescriptorSchema.safeParse(descriptor);

  return (
    <div className="card-preview">
      <div
        className={parsed.success ? 'card-preview-frame' : 'card-preview-frame card-preview-failed'}
        ref={frame}
        style={{ height: Math.round(CARD_HEIGHT * scale) }}
      >
        {parsed.success ? (
          <div className="card-preview-card" style={{ transform: `scale(${scale})` }}>
            <Card card={parsed.data} {...(images ? { images } : {})} />
          </div>
        ) : (
          'No preview'
        )}
      </div>

      {parsed.success ? (
        <p className="card-preview-note">
          The card itself, redrawn as you change these settings — the same component Proton
          rasterises for Discord, with your own name and avatar standing in.
        </p>
      ) : (
        <p className="card-preview-error">
          These settings do not describe a card Proton can draw. They are saved either way.
        </p>
      )}
    </div>
  );
}

// The signed-in member stands in for whoever the card is really about, so the preview is a picture
// of this server rather than of placeholder data. The avatar loads straight from Discord's CDN,
// the same way the app shell already draws it.
function useViewer(guildId: string): {
  avatarUrl: string | undefined;
  name: string;
  guildName: string;
} {
  const session = useQuery(sessionQuery());
  const user = session.data?.user;
  const guild = session.data?.guilds.find((candidate) => candidate.id === guildId);

  return {
    avatarUrl: user?.image ?? undefined,
    name: user?.name ?? 'Member',
    guildName: guild?.name ?? PREVIEW_SAMPLE.guildName,
  };
}

export function GreetingCardPreview({
  config,
  guildId,
}: {
  config: Record<string, unknown>;
  guildId: string;
}): ReactElement {
  const [kind, setKind] = useState<'welcome' | 'goodbye'>('welcome');
  const viewer = useViewer(guildId);
  const images = useCardImages(config, viewer.avatarUrl);

  return (
    <div className="card-preview-switcher">
      <fieldset className="segmented">
        <legend className="sr-only">Which card to preview</legend>
        {(['welcome', 'goodbye'] as const).map((option) => (
          <button
            aria-pressed={kind === option}
            className={kind === option ? 'segment is-active' : 'segment'}
            key={option}
            onClick={() => setKind(option)}
            type="button"
          >
            {option === 'welcome' ? 'Welcome' : 'Goodbye'}
          </button>
        ))}
      </fieldset>

      <CardPreview
        descriptor={greetingDescriptor(kind, config, viewer.name, viewer.guildName)}
        images={images}
      />
    </div>
  );
}

export function RankCardPreview({
  config,
  guildId,
}: {
  config: Record<string, unknown>;
  guildId: string;
}): ReactElement {
  const viewer = useViewer(guildId);
  const images = useCardImages(config, viewer.avatarUrl);

  return <CardPreview descriptor={rankDescriptor(config, viewer.name)} images={images} />;
}
