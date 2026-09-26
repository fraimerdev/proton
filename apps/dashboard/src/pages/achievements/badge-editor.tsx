import {
  BADGE_ICON_IDS,
  BADGE_ICON_LABELS,
  BADGE_ICON_PATHS,
  BADGE_SHAPE_LABELS,
  BADGE_SHAPES,
  type BadgeIconId,
  TIER_COLOURS,
  TIER_LABELS,
} from '@proton/cards/design';
import type { TierId } from '@proton/core';
import type { Achievement, Badge } from '@proton/module-achievements/config';
import { tierRank } from '@proton/module-achievements/evaluate';
import { BADGE_CONTENT_TYPES } from '@proton/module-achievements/view';
import { useMutation } from '@tanstack/react-query';
import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { CardPreview } from '../../components/discord/card-preview.tsx';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import { EditorPreviewLayout } from '../../components/discord/message-editor.tsx';
import { Button, SegmentedControl } from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { Rows, Section, SettingRow } from '../../components/ui/layout.tsx';
import { Popover } from '../../components/ui/overlay.tsx';
import { topTier } from './badge.tsx';
import { badgeUploadMutation, refuseBadgeLocally } from './queries.ts';

const ICON_COLUMNS = 4;

const SHAPE_OPTIONS = BADGE_SHAPES.map((shape) => ({
  value: shape,
  label: BADGE_SHAPE_LABELS[shape],
}));

const COLOUR_OPTIONS = [
  { value: 'tier', label: 'Tier colours' },
  { value: 'one', label: 'One colour' },
] as const;

const SINGLE_COLOURS_HELP = 'Tier colours use Proton’s blue for a single achievement.';

const IMAGE_HELP = 'PNG, JPEG or GIF, up to 256 KB and 1024×1024 pixels.';

const IMAGE_IN_USE = 'This badge uses an uploaded image.';

const PREVIEW_NOTE =
  'Members see this badge in /achievement view. Announcements and rank cards can show it too.';

const UPLOAD_UNREACHABLE = 'That image wasn’t saved: Proton didn’t respond. Try again in a moment.';

type Update = (change: (current: Achievement) => Achievement) => void;

function setBadge(update: Update, change: (badge: Badge) => Badge): void {
  update((current) => ({ ...current, badge: change(current.badge) }));
}

function uploadFailure(error: Error): string {
  if (error instanceof TypeError || error.message === '') return UPLOAD_UNREACHABLE;
  return error.message;
}

function IconGlyph({ icon, size }: { icon: BadgeIconId; size: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path d={BADGE_ICON_PATHS[icon]} fill="currentColor" />
    </svg>
  );
}

function nextIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowDown':
      return Math.min(count - 1, current + ICON_COLUMNS);
    case 'ArrowUp':
      return Math.max(0, current - ICON_COLUMNS);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

function IconPicker({
  value,
  onChange,
}: {
  value: BadgeIconId;
  onChange: (icon: BadgeIconId) => void;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    grid.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      event.preventDefault();
      setOpen(false);
      return;
    }

    const items = [...(grid.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextIndex(event.key, Math.max(0, current), items.length);
    if (next === null) return;

    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="picker-trigger achievements-editor-icon-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Icon: ${BADGE_ICON_LABELS[value]}`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="picker-value">
          <IconGlyph icon={value} size={18} />
          <span className="truncate">{BADGE_ICON_LABELS[value]}</span>
        </span>
        <Icon name="caret-down" size={12} weight="fill" className="picker-chevron" />
      </button>

      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} minWidth={300}>
        <div
          ref={grid}
          role="listbox"
          aria-label="Badge icon"
          className="achievements-editor-icon-grid"
          onKeyDown={onKeyDown}
        >
          {BADGE_ICON_IDS.map((icon) => (
            <button
              key={icon}
              type="button"
              role="option"
              aria-selected={icon === value}
              tabIndex={icon === value ? 0 : -1}
              className="achievements-editor-icon-option"
              onClick={() => {
                onChange(icon);
                setOpen(false);
              }}
            >
              <IconGlyph icon={icon} size={22} />
              <span>{BADGE_ICON_LABELS[icon]}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function previewTiers(achievement: Achievement): TierId[] {
  if (achievement.badge.colour !== 'tier') return [topTier(achievement)];
  return achievement.tiers.map((tier) => tier.id).sort((a, b) => tierRank(a) - tierRank(b));
}

function BadgePreviews({
  guildId,
  achievement,
}: {
  guildId: string;
  achievement: Achievement;
}): ReactElement {
  const { badge } = achievement;
  const captioned = badge.colour === 'tier' && achievement.kind === 'tiered';

  return (
    <div className="achievements-editor-badges">
      {previewTiers(achievement).map((tier) => (
        <figure key={tier} className="achievements-editor-badge">
          <CardPreview
            guildId={guildId}
            alt={captioned ? `${TIER_LABELS[tier]} badge` : 'Badge'}
            options={{
              kind: 'badge',
              shape: badge.shape,
              icon: badge.icon,
              colour: badge.colour === 'tier' ? TIER_COLOURS[tier] : badge.colour,
              assetId: badge.assetId,
            }}
          />
          {captioned ? <figcaption>{TIER_LABELS[tier]}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}

function ImageControl({
  guildId,
  badge,
  update,
  onFailure,
}: {
  guildId: string;
  badge: Badge;
  update: Update;
  onFailure: (message: string | null) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    ...badgeUploadMutation(guildId),
    onSuccess: (result) => {
      onFailure(null);
      setBadge(update, (current) => ({ ...current, assetId: result.assetId }));
    },
    onError: (error: Error) => onFailure(uploadFailure(error)),
  });

  return (
    <span className="inline inline-8 inline-wrap">
      <input
        ref={input}
        type="file"
        hidden
        accept={BADGE_CONTENT_TYPES.join(',')}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file === undefined) return;

          const refusal = refuseBadgeLocally(file);
          if (refusal !== null) {
            onFailure(refusal);
            return;
          }

          onFailure(null);
          upload.mutate(file);
        }}
      />

      <Button icon="image" busy={upload.isPending} onClick={() => input.current?.click()}>
        {badge.assetId === undefined ? 'Upload image' : 'Replace image'}
      </Button>

      {badge.assetId !== undefined ? (
        <Button
          tone="ghost"
          disabled={upload.isPending}
          onClick={() => {
            onFailure(null);
            setBadge(update, ({ assetId: _dropped, ...rest }) => rest);
          }}
        >
          Use an icon instead
        </Button>
      ) : null}
    </span>
  );
}

export function BadgeEditor({
  guildId,
  achievement,
  path,
  errorAt,
  update,
}: {
  guildId: string;
  achievement: Achievement;
  path: string;
  errorAt: (path: string) => string | undefined;
  update: Update;
}): ReactElement {
  const [failure, setFailure] = useState<string | null>(null);
  const { badge } = achievement;
  const oneColour = badge.colour !== 'tier';

  const settings = (
    <Section label="Badge">
      <Rows>
        <SettingRow title="Shape" error={errorAt(`${path}.badge.shape`)}>
          <SegmentedControl
            label="Shape"
            options={SHAPE_OPTIONS}
            value={badge.shape}
            onChange={(shape) => setBadge(update, (current) => ({ ...current, shape }))}
          />
        </SettingRow>

        {badge.assetId === undefined ? (
          <SettingRow title="Icon" error={errorAt(`${path}.badge.icon`)}>
            <IconPicker
              value={badge.icon}
              onChange={(icon) => setBadge(update, (current) => ({ ...current, icon }))}
            />
          </SettingRow>
        ) : null}

        <SettingRow
          title="Image"
          description={IMAGE_HELP}
          error={failure ?? errorAt(`${path}.badge.assetId`)}
          note={badge.assetId !== undefined ? IMAGE_IN_USE : undefined}
        >
          <ImageControl guildId={guildId} badge={badge} update={update} onFailure={setFailure} />
        </SettingRow>

        <SettingRow
          title="Colour"
          description={achievement.kind === 'tiered' ? undefined : SINGLE_COLOURS_HELP}
          error={errorAt(`${path}.badge.colour`)}
        >
          <SegmentedControl
            label="Colour"
            options={COLOUR_OPTIONS}
            value={oneColour ? 'one' : 'tier'}
            onChange={(mode) =>
              setBadge(update, (current) => ({
                ...current,
                colour: mode === 'tier' ? 'tier' : TIER_COLOURS[topTier(achievement)],
              }))
            }
          />
        </SettingRow>

        {badge.colour !== 'tier' ? (
          <SettingRow title="Badge colour">
            <ColourPicker
              label="Badge colour"
              value={badge.colour}
              onChange={(colour) => setBadge(update, (current) => ({ ...current, colour }))}
            />
          </SettingRow>
        ) : null}
      </Rows>
    </Section>
  );

  return (
    <EditorPreviewLayout
      editor={settings}
      previewTitle="Badge"
      preview={
        <>
          <BadgePreviews guildId={guildId} achievement={achievement} />
          <p className="achievements-editor-note">{PREVIEW_NOTE}</p>
        </>
      }
    />
  );
}
