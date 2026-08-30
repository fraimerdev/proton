import { coloursFor } from '@proton/module-branding/colour';
import { applyTypeface, isTypeface } from '@proton/module-branding/typeface';
import type { CSSProperties, ReactElement } from 'react';

export interface BrandingDiscordPreviewProps {
  config: Record<string, unknown>;
  guildId: string;
}

function text(config: Record<string, unknown>, key: string): string | null {
  const held = config[key];
  return typeof held === 'string' && held.trim().length > 0 ? held : null;
}

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}

// A gradient name is painted by Discord from the role's colours, so the preview paints the text the
// same way rather than picking one of the two and calling it close enough.
export function nameStyle(config: Record<string, unknown>): CSSProperties | undefined {
  const colours = coloursFor(config as never);
  if (!colours) return undefined;

  const primary = hex(colours.primaryColor);

  if (colours.secondaryColor === null || colours.secondaryColor === undefined) {
    return { color: primary };
  }

  return {
    background: `linear-gradient(90deg, ${primary}, ${hex(colours.secondaryColor)})`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  };
}

export function styledName(config: Record<string, unknown>, fallback: string): string {
  const nickname = text(config, 'nickname') ?? fallback;
  const face = config.typeface;

  return typeof face === 'string' && isTypeface(face) ? applyTypeface(nickname, face) : nickname;
}

// Fixed, not the clock: a preview that ticks redraws under the admin while they read it, and the
// time is chrome here rather than information.
const STAMP = 'Today at 09:41';

const SAMPLE = 'Ready. Members can open a ticket with /ticket.';

export function BrandingDiscordPreview({
  config,
  guildId,
}: BrandingDiscordPreviewProps): ReactElement {
  const avatarHash = text(config, 'avatarHash');

  const avatar = avatarHash
    ? `/api/guilds/${guildId}/branding/avatar?v=${avatarHash}`
    : '/proton-mark.png';

  return (
    <figure className="dc-fence">
      <figcaption className="dc-fence-head">
        <span className="dc-fence-label">Discord preview</span>
        <span className="dc-fence-note">How Proton reads in this server once this is applied</span>
      </figcaption>

      <div className="dc-surface">
        <div className="dc-message">
          <img className="dc-avatar" src={avatar} alt="" decoding="async" />

          <div className="dc-body">
            <div className="dc-head">
              <span className="dc-author" style={nameStyle(config)}>
                {styledName(config, 'Proton')}
              </span>
              <span className="dc-app">APP</span>
              <span className="dc-time">{STAMP}</span>
            </div>

            <div className="dc-content">{SAMPLE}</div>
          </div>
        </div>
      </div>
    </figure>
  );
}
