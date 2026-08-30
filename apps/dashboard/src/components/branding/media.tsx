import {
  ACCEPTED_TYPES,
  AVATAR_MAX_BYTES,
  BANNER_MAX_BYTES,
  kilobytes,
} from '@proton/module-branding/kinds';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useId, useRef, useState } from 'react';
import { queryKeys } from '../../lib/query-keys.ts';
import { Icon } from '../shell/icon.tsx';

const MODULE_ID = 'branding';

export type AssetKind = 'avatar' | 'banner';

const CAPS: Record<AssetKind, number> = { avatar: AVATAR_MAX_BYTES, banner: BANNER_MAX_BYTES };

const LABELS: Record<AssetKind, { title: string; hint: string }> = {
  avatar: {
    title: 'Avatar',
    hint: 'Square. PNG, JPEG or GIF, up to 1 MB.',
  },
  banner: {
    title: 'Banner',
    hint: 'Roughly 4:1. PNG, JPEG or GIF, up to 2 MB.',
  },
};

export interface BrandingMediaProps {
  guildId: string;
  kind: AssetKind;

  hash: string | undefined;
  onChanged: () => void;
}

export function BrandingMedia({
  guildId,
  kind,
  hash,
  onChanged,
}: BrandingMediaProps): ReactElement {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const queries = useQueryClient();

  const [busy, setBusy] = useState<'upload' | 'clear' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  const label = LABELS[kind];
  const set = hash !== undefined;

  // Keyed on the hash so a replaced image is refetched: the URL never changes, and without this the
  // browser keeps showing the picture the admin has just overwritten.
  const src = set ? `/api/guilds/${guildId}/branding/${kind}?v=${hash}` : null;

  // Settings say the image is there and it did not load, which is a different thing from nothing
  // being set. A broken-image glyph would let the admin read it as the second.
  const missing = src !== null && broken;

  async function send(file: File): Promise<void> {
    if (file.size > CAPS[kind]) {
      setFailure(
        `That image is ${kilobytes(file.size)}, and a ${kind} may be at most ${kilobytes(CAPS[kind])}.`,
      );
      return;
    }

    setBusy('upload');
    setFailure(null);

    try {
      const response = await fetch(`/api/guilds/${guildId}/branding/${kind}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });

      if (!response.ok) {
        setFailure((await response.text()).trim() || 'Proton could not save that image.');
        return;
      }

      // The upload writes the module config too, so this page's copy of it is now stale. The
      // config is a query, not a route loader, so invalidating the router would refetch nothing.
      await queries.invalidateQueries({ queryKey: queryKeys.moduleConfig(guildId, MODULE_ID) });
      onChanged();
    } catch {
      setFailure('Proton could not reach the server to save that image.');
    } finally {
      setBusy(null);
      setBroken(false);
      if (input.current) input.current.value = '';
    }
  }

  async function clear(): Promise<void> {
    setBusy('clear');
    setFailure(null);

    try {
      const response = await fetch(`/api/guilds/${guildId}/branding/${kind}`, { method: 'DELETE' });
      if (!response.ok) {
        setFailure((await response.text()).trim() || 'Proton could not clear that image.');
        return;
      }

      await queries.invalidateQueries({ queryKey: queryKeys.moduleConfig(guildId, MODULE_ID) });
      onChanged();
    } catch {
      setFailure('Proton could not reach the server to clear that image.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="branding-media">
      <span className={kind === 'avatar' ? 'branding-slot round' : 'branding-slot wide'}>
        {src && !missing ? (
          <img src={src} alt={`${label.title} for this server`} onError={() => setBroken(true)} />
        ) : (
          <span className="branding-slot-empty">{missing ? 'Missing' : 'None'}</span>
        )}
      </span>

      <div className="branding-media-body">
        <span className="branding-media-title" id={`${id}-title`}>
          {label.title}
        </span>
        <p className="status">{label.hint}</p>

        <div className="branding-media-actions">
          <label className="button button-quiet" htmlFor={`${id}-file`}>
            <Icon name="upload-simple" />
            {busy === 'upload' ? 'Uploading…' : set ? 'Replace' : 'Upload'}
          </label>
          <input
            ref={input}
            id={`${id}-file`}
            className="sr-only"
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            disabled={busy !== null}
            aria-describedby={`${id}-title`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void send(file);
            }}
          />

          <button
            type="button"
            className="button button-quiet"
            disabled={!set || busy !== null}
            onClick={() => void clear()}
          >
            <Icon name="trash" />
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </button>
        </div>

        <p className="status" role="status">
          {failure ? (
            <span className="branding-failure">{failure}</span>
          ) : missing ? (
            <span className="branding-failure">
              This server has a {kind} saved but Proton could not load it. Upload it again.
            </span>
          ) : set ? (
            'Saved. It is applied in this server within moments.'
          ) : (
            'Nothing set, so Proton uses its own picture here.'
          )}
        </p>
      </div>
    </div>
  );
}
