import type { BrandingConfig } from '@proton/module-branding/config';
import type { DisplayNameStyle } from '@proton/module-branding/name-style';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { AppTag } from '../../../components/discord/identity.tsx';
import { SegmentedControl, type SegmentedOption } from '../../../components/ui/controls.tsx';
import { Spinner } from '../../../components/ui/feedback.tsx';
import {
  type AccountRead,
  BrandingAvatar,
  BrandingName,
  BrandingProfile,
} from '../discord-preview.tsx';
import { faceFor, faceNote } from './faces.ts';
import { graphemes, NAME_STYLE_HELP } from './shape.ts';
import { GlyphRuns, NameSpecimen, usePrefersReducedMotion } from './specimen.tsx';

type Background = 'dark' | 'light';
type Motion = 'animated' | 'still';

const BACKGROUNDS: readonly SegmentedOption<Background>[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const MOTIONS: readonly SegmentedOption<Motion>[] = [
  { value: 'animated', label: 'Animated' },
  { value: 'still', label: 'Still' },
];

const LISTED = 5;

function listOf(items: readonly string[]): string {
  const shown = items.slice(0, LISTED);
  const all = items.length > LISTED ? [...shown, `${items.length - LISTED} more`] : shown;
  const last = all[all.length - 1] ?? '';

  return all.length <= 1 ? last : `${all.slice(0, -1).join(', ')} and ${last}`;
}

function notesFor(
  style: DisplayNameStyle | null,
  name: string,
  failed: boolean,
  missing: ReadonlySet<number>,
): string[] {
  if (style === null) return [];

  const face = faceFor(style.font);
  const notes: string[] = [];

  const substitution = faceNote(face);
  if (substitution !== null) notes.push(substitution);

  if (failed) {
    notes.push(
      `Proton could not load the ${face.drawnIn} file, so this preview uses its fallback font.`,
    );
  }

  if (missing.size > 0) {
    const parts = graphemes(name);
    const glyphs = [
      ...new Set([...missing].map((index) => parts[index]).filter((part) => part !== undefined)),
    ];
    const one = glyphs.length === 1;

    notes.push(
      face.status === 'bundled'
        ? `${face.drawnIn} has no ${listOf(glyphs)}, so Discord draws ${one ? 'it' : 'them'} in a different font and ${one ? 'it' : 'they'} will not match.`
        : `${face.drawnIn} has no ${listOf(glyphs)}, so this preview draws ${one ? 'it' : 'them'} in a fallback font.`,
    );
  }

  return notes;
}

export function NameStylePreviews({
  guildId,
  config,
  read,
  style,
  name,
  loading,
  failed,
  missing,
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
  style: DisplayNameStyle | null;
  name: string;
  loading: boolean;
  failed: boolean;
  missing: ReadonlySet<number>;
}): ReactElement {
  const reduced = usePrefersReducedMotion();
  const [background, setBackground] = useState<Background>('dark');
  const [motion, setMotion] = useState<Motion>('animated');

  const notes = [...notesFor(style, name, failed, missing), ...NAME_STYLE_HELP];
  const spinner =
    loading && style !== null ? <Spinner size="sm" status label="Loading the font" /> : null;

  return (
    <div
      className="name-style-previews"
      data-background={background}
      data-motion={reduced || motion === 'still' ? 'still' : 'animated'}
    >
      <div className="name-style-preview-controls">
        <SegmentedControl
          label="Background"
          options={BACKGROUNDS}
          value={background}
          onChange={setBackground}
        />
        {reduced ? (
          <p className="name-style-caption">Still, because your device asks for reduced motion.</p>
        ) : (
          <SegmentedControl label="Motion" options={MOTIONS} value={motion} onChange={setMotion} />
        )}
      </div>

      <div className="name-style-panes">
        <div className="name-style-pane" data-pane="profile">
          <div className="name-style-pane-head">
            <span className="name-style-pane-title">Profile</span>
            {spinner}
          </div>
          <BrandingProfile
            guildId={guildId}
            config={config}
            read={read}
            name={
              style === null ? (
                <BrandingName>{name}</BrandingName>
              ) : (
                <NameSpecimen
                  font={style.font}
                  effect={style.effect}
                  colours={style.colours}
                  text={name}
                  missing={missing}
                />
              )
            }
          />
        </div>

        <div className="name-style-pane" data-pane="message">
          <div className="name-style-pane-head">
            <span className="name-style-pane-title">Server message</span>
            {spinner}
          </div>
          <div className="dc">
            <div className="dc-message">
              <BrandingAvatar guildId={guildId} config={config} read={read} className="dc-avatar" />
              <div className="dc-body">
                <div className="dc-head">
                  <BrandingName className="dc-author" font={style?.font}>
                    <GlyphRuns text={name} missing={missing} />
                  </BrandingName>
                  <AppTag />
                  <span className="dc-timestamp">Today at 12:00</span>
                </div>
                <div className="dc-content">
                  Warned <span className="dc-mention">@member</span>.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ul className="name-style-notes">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
