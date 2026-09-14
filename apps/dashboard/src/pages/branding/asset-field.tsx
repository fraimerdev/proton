import {
  ACCEPTED_TYPES,
  type AssetKind,
  kilobytes,
  maxBytesFor,
} from '@proton/module-branding/kinds';
import type { ReactElement } from 'react';
import { useRef } from 'react';
import { Button } from '../../components/ui/controls.tsx';

export function assetSource(guildId: string, kind: AssetKind, hash: string): string {
  return `/api/guilds/${guildId}/branding/${kind}?v=${hash}`;
}

// A courtesy only: the server sniffs magic bytes and is the authority, so these are its sentences.
export function refuseLocally(file: File, kind: AssetKind): string | null {
  if (file.size === 0) return 'That image was not saved: that file is empty.';

  const cap = maxBytesFor(kind);
  if (file.size > cap) {
    return `That image was not saved: that image is ${kilobytes(file.size)}, and a ${kind} may be at most ${kilobytes(cap)}.`;
  }

  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return 'That image was not saved: that file is not a PNG, JPEG or GIF. Discord accepts no other format.';
  }

  return null;
}

export function AssetField({
  kind,
  guildId,
  hash,
  busy,
  onFile,
  onClear,
}: {
  kind: AssetKind;
  guildId: string;
  hash: string | undefined;
  busy: boolean;
  onFile: (file: File) => void;
  onClear: () => void;
}): ReactElement {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <span className="branding-asset">
      {hash !== undefined ? (
        <img
          className={kind === 'avatar' ? 'branding-asset-avatar' : 'branding-asset-banner'}
          src={assetSource(guildId, kind, hash)}
          alt={kind === 'avatar' ? 'Proton’s avatar' : 'Proton’s banner'}
        />
      ) : null}

      <input
        ref={picker}
        type="file"
        hidden
        accept={ACCEPTED_TYPES.join(',')}
        aria-label={kind === 'avatar' ? 'Choose an avatar' : 'Choose a banner'}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Read first, then cleared: an unchanged value fires no second change, so re-picking the
          // same file after a refusal would do nothing.
          event.currentTarget.value = '';
          if (file) onFile(file);
        }}
      />

      <Button size="sm" icon="image" busy={busy} onClick={() => picker.current?.click()}>
        {hash === undefined ? 'Upload' : 'Replace'}
      </Button>

      {hash !== undefined ? (
        <Button tone="danger-quiet" size="sm" icon="trash" disabled={busy} onClick={onClear}>
          Remove
        </Button>
      ) : null}
    </span>
  );
}
