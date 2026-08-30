// Subpaths, never the barrel: the barrel reaches @proton/db and drizzle for the asset store, which
// have no business in a browser bundle.
import { BIO_MAX } from '@proton/module-branding/config';
import { impersonationReason } from '@proton/module-branding/names';
import { type ReactElement, useState } from 'react';
import { nameStyle, styledName } from './discord-preview.tsx';

export interface BrandingPreviewProps {
  config: Record<string, unknown>;
  guildId: string;
}

function text(config: Record<string, unknown>, key: string): string | null {
  const held = config[key];
  return typeof held === 'string' && held.trim().length > 0 ? held : null;
}

function Media({ url, alt, className }: { url: string; alt: string; className: string }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <p className={`${className} branding-broken status`}>Proton could not load this image.</p>
    );
  }

  return <img className={className} src={url} alt={alt} onError={() => setBroken(true)} />;
}

export function BrandingPreview({ config, guildId }: BrandingPreviewProps): ReactElement {
  const nickname = text(config, 'nickname');
  const bio = text(config, 'bio');

  const avatarHash = text(config, 'avatarHash');
  const bannerHash = text(config, 'bannerHash');

  // ?v= the hash, so replacing an image repaints: the path is stable and the browser would
  // otherwise keep showing the picture that has just been overwritten.
  const avatarUrl = avatarHash ? `/api/guilds/${guildId}/branding/avatar?v=${avatarHash}` : null;
  const bannerUrl = bannerHash ? `/api/guilds/${guildId}/branding/banner?v=${bannerHash}` : null;

  const refusal = nickname === null ? null : impersonationReason(nickname);
  const over = bio !== null && bio.length > BIO_MAX;

  return (
    <div className="branding-preview">
      <div className="branding-card">
        {bannerUrl ? (
          <Media url={bannerUrl} alt="Banner" className="branding-banner" />
        ) : (
          <div className="branding-banner branding-banner-empty" />
        )}

        <div className="branding-identity">
          {avatarUrl ? (
            <Media url={avatarUrl} alt="Avatar" className="branding-avatar" />
          ) : (
            <img className="branding-avatar" src="/proton-mark.png" alt="Proton's own avatar" />
          )}

          <div className="branding-names">
            <span className="branding-name" style={nameStyle(config)}>
              {styledName(config, 'Proton')}
            </span>
            <span className="branding-handle">
              {nickname === null ? 'Its own name, in every server' : 'Only in this server'}
            </span>
          </div>
        </div>

        <p className={bio === null ? 'branding-bio status' : 'branding-bio'}>
          {bio ?? 'No bio set.'}
        </p>
      </div>

      <div className="branding-notes">
        {refusal ? (
          <p className="status branding-refused">Proton will not take this nickname: {refusal}.</p>
        ) : null}

        {over ? (
          <p className="status branding-refused">
            The bio is {bio.length} characters. Discord’s own client stops at {BIO_MAX}, so this
            will not save.
          </p>
        ) : null}

        <p className="status">
          Drawn from the settings on this page, not read back from Discord. Discord does not report
          a bot’s bio at all, so this shows what Proton last sent rather than what Discord holds.
          Run <code>/branding</code> in the server to re-apply and see what Discord said.
        </p>
      </div>
    </div>
  );
}
