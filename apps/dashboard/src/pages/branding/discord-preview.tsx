import type { BrandingConfig } from '@proton/module-branding/config';
import type { NameStyleFont } from '@proton/module-branding/name-style';
import { impersonationReason } from '@proton/module-branding/names';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AppTag } from '../../components/discord/identity.tsx';
import { DiscordMarkdown } from '../../components/discord/markdown.tsx';
import { cx } from '../../components/ui/controls.tsx';
import { Spinner, type SpinnerSize } from '../../components/ui/feedback.tsx';
import type { ProtonAccount } from '../../lib/discord.ts';
import { assetSource } from './asset-field.tsx';
import { faceFor, faceNote, fontStack } from './name-style/faces.ts';
import { useFaces } from './name-style/load-face.ts';
import { DEFAULT_COLOUR_NOTE, NAME_STYLE_HELP } from './name-style/shape.ts';
import { NameSpecimen, usePrefersReducedMotion } from './name-style/specimen.tsx';

const PROTON_NAME = 'Proton';

const SAMPLE = 24;

export type AccountRead =
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'ready'; account: ProtonAccount };

interface Bucket {
  count: number;
  red: number;
  green: number;
  blue: number;
}

export function accountReadOf(query: {
  data: ProtonAccount | undefined;
  isError: boolean;
}): AccountRead {
  if (query.data !== undefined) return { status: 'ready', account: query.data };
  return query.isError ? { status: 'failed' } : { status: 'pending' };
}

function isRefused(config: BrandingConfig): boolean {
  return config.nickname !== undefined && impersonationReason(config.nickname) !== null;
}

function ownName(read: AccountRead): string {
  return read.status === 'ready' ? (read.account.globalName ?? read.account.username) : PROTON_NAME;
}

export function shownName(config: BrandingConfig, read: AccountRead): string {
  if (config.nickname === undefined) return ownName(read);
  if (!isRefused(config)) return config.nickname;

  // A refused nickname is never sent, so Discord keeps whichever one Proton was last given.
  return (read.status === 'ready' ? read.account.nickname : null) ?? ownName(read);
}

function usernameOf(read: AccountRead): string {
  if (read.status !== 'ready') return PROTON_NAME;

  const { username, discriminator } = read.account;
  return discriminator === null ? username : `${username}#${discriminator}`;
}

function avatarOf(guildId: string, config: BrandingConfig, read: AccountRead): string | undefined {
  if (config.avatarHash !== undefined) return assetSource(guildId, 'avatar', config.avatarHash);
  return read.status === 'ready' ? read.account.avatarUrl : undefined;
}

export function previewNotesFor(
  config: BrandingConfig,
  read: AccountRead,
  enabled: boolean,
): string[] {
  const notes: string[] = [];

  if (!enabled) {
    notes.push(
      'Branding is switched off, so none of this reaches Discord until it is switched on.',
    );
  }
  if (isRefused(config)) {
    notes.push('Proton will not send this nickname, so Discord keeps the one it has now.');
  }
  if (read.status === 'failed') {
    notes.push(
      'Proton could not read its own Discord account, so any name or avatar this preview takes from it is a stand-in.',
    );
    if (config.avatarHash === undefined) {
      notes.push('With no avatar uploaded, Discord shows Proton’s own avatar.');
    }
  }
  if (config.bannerHash === undefined) {
    notes.push(
      'With no banner uploaded, Discord shows Proton’s own banner if it has one, otherwise a colour taken from the avatar.',
    );
  } else {
    notes.push('Discord crops banners to its own shape, so this is approximate.');
  }
  if (config.displayNameStyle === null) {
    notes.push(DEFAULT_COLOUR_NOTE);
  } else {
    const substitution = faceNote(faceFor(config.displayNameStyle.font));
    if (substitution !== null) notes.push(substitution);
    notes.push(...NAME_STYLE_HELP);
  }

  return notes;
}

export function dominantOf(pixels: Uint8ClampedArray): string | null {
  const buckets = new Map<number, Bucket>();
  let top: Bucket | null = null;

  for (let at = 0; at + 3 < pixels.length; at += 4) {
    if ((pixels[at + 3] ?? 0) < 128) continue;

    const red = pixels[at] ?? 0;
    const green = pixels[at + 1] ?? 0;
    const blue = pixels[at + 2] ?? 0;
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);

    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);

    if (top === null || bucket.count > top.count) top = bucket;
  }

  if (top === null) return null;

  const { count, red, green, blue } = top;
  return `rgb(${Math.round(red / count)} ${Math.round(green / count)} ${Math.round(blue / count)})`;
}

function readPixels(context: CanvasRenderingContext2D): Uint8ClampedArray | null {
  try {
    return context.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch {
    return null;
  }
}

function dominantColour(image: HTMLImageElement): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;

  context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  const pixels = readPixels(context);

  return pixels === null ? null : dominantOf(pixels);
}

// Discord paints a profile with no banner in a colour taken from its avatar, not a fixed grey.
function useBannerColour(avatar: string | undefined): string | null {
  const [sampled, setSampled] = useState<{ from: string; colour: string | null } | null>(null);

  useEffect(() => {
    if (avatar === undefined) return;

    let current = true;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (current) setSampled({ from: avatar, colour: dominantColour(image) });
    };
    image.src = avatar;

    return () => {
      current = false;
    };
  }, [avatar]);

  return sampled !== null && sampled.from === avatar ? sampled.colour : null;
}

export function BrandingAvatar({
  guildId,
  config,
  read,
  className,
  spinner = 'sm',
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
  className: string;
  spinner?: SpinnerSize | undefined;
}): ReactElement {
  const src = avatarOf(guildId, config, read);

  if (src !== undefined) return <img className={className} src={src} alt="" />;

  if (read.status === 'pending') {
    return (
      <span className={cx(className, 'branding-avatar-pending')}>
        <Spinner size={spinner} label="Loading Proton’s avatar" />
      </span>
    );
  }

  return <span className={className} />;
}

export function BrandingName({
  className,
  font,
  children,
}: {
  className?: string | undefined;
  font?: NameStyleFont | undefined;
  children: ReactNode;
}): ReactElement {
  const style: CSSProperties | undefined =
    font === undefined
      ? undefined
      : { fontFamily: fontStack(font), fontWeight: faceFor(font).weight, fontSynthesis: 'none' };

  return (
    <span className={cx('branding-name', className)} style={style}>
      {children}
    </span>
  );
}

function ProfileName({
  config,
  read,
}: {
  config: BrandingConfig;
  read: AccountRead;
}): ReactElement {
  const style = config.displayNameStyle;
  const text = shownName(config, read);

  if (style === null) return <BrandingName>{text}</BrandingName>;

  return (
    <NameSpecimen font={style.font} effect={style.effect} colours={style.colours} text={text} />
  );
}

export function BrandingProfile({
  guildId,
  config,
  read,
  name,
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
  name?: ReactNode;
}): ReactElement {
  const avatar = avatarOf(guildId, config, read);
  const bannerColour = useBannerColour(config.bannerHash === undefined ? avatar : undefined);
  const bio = config.bio ?? '';

  return (
    <div className="dc branding-popout">
      {config.bannerHash !== undefined ? (
        <img
          className="branding-popout-banner"
          src={assetSource(guildId, 'banner', config.bannerHash)}
          alt=""
        />
      ) : (
        <div
          className="branding-popout-banner"
          style={bannerColour === null ? undefined : { backgroundColor: bannerColour }}
        />
      )}

      <div className="branding-popout-body">
        <BrandingAvatar
          guildId={guildId}
          config={config}
          read={read}
          className="branding-popout-avatar"
          spinner="lg"
        />

        <p className="branding-popout-name">
          {name ?? <ProfileName config={config} read={read} />}
        </p>
        <p className="branding-popout-username">
          <span>{usernameOf(read)}</span>
          <AppTag />
        </p>

        {bio.trim() !== '' ? (
          <div className="branding-popout-section">
            <p className="branding-popout-heading">About me</p>
            <div className="branding-popout-bio">
              <DiscordMarkdown text={bio} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BrandingMessage({
  guildId,
  config,
  read,
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
}): ReactElement {
  return (
    <div className="dc branding-message">
      <div className="dc-message">
        <BrandingAvatar guildId={guildId} config={config} read={read} className="dc-avatar" />
        <div className="dc-body">
          <div className="dc-head">
            <BrandingName className="dc-author" font={config.displayNameStyle?.font}>
              {shownName(config, read)}
            </BrandingName>
            <AppTag />
            <span className="dc-timestamp">Today at 12:00</span>
          </div>
          <div className="dc-content">
            Warned <span className="dc-mention">@member</span> for spamming.
          </div>
        </div>
      </div>
    </div>
  );
}

function BrandingMember({
  guildId,
  config,
  read,
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
}): ReactElement {
  return (
    <div className="dc branding-members">
      <div className="branding-member">
        <BrandingAvatar
          guildId={guildId}
          config={config}
          read={read}
          className="branding-member-avatar"
        />
        <BrandingName className="branding-member-name" font={config.displayNameStyle?.font}>
          {shownName(config, read)}
        </BrandingName>
        <AppTag />
      </div>
    </div>
  );
}

export function BrandingPreview({
  guildId,
  config,
  read,
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
}): ReactElement {
  const reduced = usePrefersReducedMotion();
  const font = config.displayNameStyle?.font;
  const faces = useFaces(font === undefined ? [] : [font, 'gg-sans'], shownName(config, read));
  const loading = font !== undefined && faces.status === 'loading';

  return (
    <div className="branding-preview" data-motion={reduced ? 'still' : 'animated'}>
      <figure className="branding-preview-part">
        <figcaption className="branding-preview-label">
          Profile
          {loading ? <Spinner size="sm" status label="Loading the font" /> : null}
        </figcaption>
        <BrandingProfile guildId={guildId} config={config} read={read} />
      </figure>

      <figure className="branding-preview-part">
        <figcaption className="branding-preview-label">Sample message</figcaption>
        <BrandingMessage guildId={guildId} config={config} read={read} />
      </figure>

      <figure className="branding-preview-part">
        <figcaption className="branding-preview-label">Member list</figcaption>
        <BrandingMember guildId={guildId} config={config} read={read} />
      </figure>
    </div>
  );
}
