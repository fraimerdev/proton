import { coloursFor } from '@proton/module-branding/colour';
import type { BrandingConfig } from '@proton/module-branding/config';
import { applyTypeface } from '@proton/module-branding/typeface';
import type { ReactElement } from 'react';
import { DiscordMarkdown } from '../../components/discord/markdown.tsx';
import { cx } from '../../components/ui/controls.tsx';
import { assetSource } from './asset-field.tsx';

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

// Not DiscordPreview: branding produces a profile, not a message. A gradient is drawn as its two
// colours and a sentence, never as a CSS ramp, which would be a picture Discord does not draw.
export function BrandingProfile({
  guildId,
  config,
}: {
  guildId: string;
  config: BrandingConfig;
}): ReactElement {
  const colours = coloursFor(config);
  const name = applyTypeface(config.nickname ?? 'Proton', config.typeface);

  return (
    <div className={cx('dc', 'branding-profile', config.bannerHash !== undefined && 'has-banner')}>
      {config.bannerHash !== undefined ? (
        <img
          className="branding-profile-banner"
          src={assetSource(guildId, 'banner', config.bannerHash)}
          alt=""
        />
      ) : null}

      <div className="branding-profile-body">
        {config.avatarHash !== undefined ? (
          <img
            className="branding-profile-avatar"
            src={assetSource(guildId, 'avatar', config.avatarHash)}
            alt=""
          />
        ) : (
          <span className="branding-profile-avatar" />
        )}

        <div className="branding-profile-name">
          <span style={colours === null ? undefined : { color: hex(colours.primaryColor) }}>
            {name}
          </span>
          <span className="dc-bot-tag">App</span>
        </div>

        {colours !== null && typeof colours.secondaryColor === 'number' ? (
          <div className="branding-profile-swatches">
            <span
              className="branding-profile-swatch"
              style={{ background: hex(colours.primaryColor) }}
            />
            <span
              className="branding-profile-swatch"
              style={{ background: hex(colours.secondaryColor) }}
            />
            {typeof colours.tertiaryColor === 'number' ? (
              <span
                className="branding-profile-swatch"
                style={{ background: hex(colours.tertiaryColor) }}
              />
            ) : null}
            <span className="dc-small">
              Discord draws this as a{' '}
              {config.nameEffect === 'holographic' ? 'holographic' : 'gradient'} name.
            </span>
          </div>
        ) : null}

        {config.bio !== undefined && config.bio !== '' ? (
          <div className="branding-profile-bio">
            <DiscordMarkdown text={config.bio} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
