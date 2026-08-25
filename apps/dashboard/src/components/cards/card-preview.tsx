import { type ReactElement, useEffect, useState } from 'react';

export type PreviewKind = 'rank' | 'welcome' | 'goodbye';

export interface CardPreviewProps {
  kind: PreviewKind;
  config: Record<string, unknown>;
  guildId: string;

  presetKey: string;

  toggles: Readonly<Record<string, string>>;
}

// Long enough that dragging a colour picker does not queue a render per pixel, short enough that
// the picture still feels attached to the control that changed it.
const DEBOUNCE_MS = 400;

function flag(value: unknown): string | null {
  return typeof value === 'boolean' ? String(value) : null;
}

function queryFor(props: CardPreviewProps): string {
  const params = new URLSearchParams({ kind: props.kind });

  const preset = props.config[props.presetKey];
  if (typeof preset === 'string') params.set('preset', preset);

  const accent = props.config.cardAccent;
  if (typeof accent === 'number') params.set('accent', String(accent));

  const background = props.config.cardBackgroundUrl;
  if (typeof background === 'string' && background.length > 0) params.set('background', background);

  for (const [configKey, param] of Object.entries(props.toggles)) {
    const value = flag(props.config[configKey]);
    if (value !== null) params.set(param, value);
  }

  return params.toString();
}

export function CardPreview(props: CardPreviewProps): ReactElement {
  const guildId = props.guildId;
  const query = queryFor(props);

  const [src, setSrc] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!guildId) return;

    const abort = new AbortController();
    let objectUrl: string | null = null;

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/guilds/${guildId}/card-preview?${query}`, {
          signal: abort.signal,
        });

        if (!response.ok) {
          const body = (await response.text()).trim();
          setSrc(null);

          // Only the route's own sentences are copy. Anything else — a proxy's HTML error page, an
          // empty body — is a machine string, and printing it under the preview says nothing.
          setFailure(
            body.length > 0 && body.length < 300 && !body.startsWith('<')
              ? body
              : 'Proton could not render this card. The settings above are saved either way.',
          );
          return;
        }

        objectUrl = URL.createObjectURL(await response.blob());
        setFailure(null);
        setSrc(objectUrl);
      } catch {
        if (abort.signal.aborted) return;
        setSrc(null);
        setFailure(
          'Proton could not reach the preview renderer. The settings above are saved either way.',
        );
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [guildId, query]);

  return (
    <div className="card-preview">
      {/* A failed render is not a render still in progress. Both failure paths leave src null, so
          the pending frame used to sit under the coral line forever, saying the opposite of it. */}
      {failure !== null ? (
        <div className="card-preview-frame card-preview-failed">No preview</div>
      ) : src === null ? (
        <div className="card-preview-frame card-preview-pending">Rendering…</div>
      ) : (
        <img alt="Preview of the card Proton will send" className="card-preview-image" src={src} />
      )}

      {failure === null ? (
        <p className="card-preview-note">
          Rendered by Proton itself, with your own name and avatar as the sample.
        </p>
      ) : (
        <p className="card-preview-error">{failure}</p>
      )}
    </div>
  );
}

export function GreetingCardPreview({
  config,
  guildId,
}: {
  config: Record<string, unknown>;
  guildId: string;
}): ReactElement {
  const [kind, setKind] = useState<PreviewKind>('welcome');

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
        config={config}
        guildId={guildId}
        kind={kind}
        presetKey="preset"
        toggles={{ cardShowMemberCount: 'showMemberCount' }}
      />
    </div>
  );
}
