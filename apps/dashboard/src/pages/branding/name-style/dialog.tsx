import type { BrandingConfig } from '@proton/module-branding/config';
import {
  type DisplayNameStyle,
  NAME_STYLE_FONT_LABELS,
  NAME_STYLE_FONTS,
} from '@proton/module-branding/name-style';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { Button } from '../../../components/ui/controls.tsx';
import { Dialog } from '../../../components/ui/overlay.tsx';
import { type AccountRead, shownName } from '../discord-preview.tsx';
import { NameStyleColours } from './colours.tsx';
import { EffectGrid } from './effect-grid.tsx';
import { FontGrid } from './font-grid.tsx';
import { useFaces, useMissingGlyphs } from './load-face.ts';
import { NameStylePreviews } from './previews.tsx';
import {
  canConfirm,
  draftFrom,
  issueAt,
  type NameStyleChoice,
  type NameStyleDraft,
  styleFrom,
  withChoice,
  withEffect,
  withFont,
} from './shape.ts';
import { RadioTiles } from './tiles.tsx';

export const NAME_STYLE_DIALOG_TITLE = 'Display name style';

export const NAME_STYLE_DIALOG_DESCRIPTION =
  'Choose how Proton’s name looks in this server. Save the page to apply it in Discord.';

const TILE_TEXT = `${NAME_STYLE_FONTS.map((font) => NAME_STYLE_FONT_LABELS[font]).join('')}Aa`;

const CHOICES: readonly NameStyleChoice[] = ['none', 'custom'];

const CHOICE_LABELS: Readonly<Record<NameStyleChoice, string>> = {
  none: 'No style',
  custom: 'Custom style',
};

const CHOICE_HINTS: Readonly<Record<NameStyleChoice, string>> = {
  none: 'Discord’s usual name',
  custom: 'Your font, effect and colours',
};

export function NameStyleEditor({
  guildId,
  config,
  read,
  draft,
  onDraft,
}: {
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
  draft: NameStyleDraft;
  onDraft: (next: NameStyleDraft) => void;
}): ReactElement {
  const choiceId = useId();
  const name = shownName(config, read);
  const faces = useFaces(NAME_STYLE_FONTS, `${TILE_TEXT}${name}`);
  const loading = faces.status === 'loading';
  const custom = draft.kind === 'custom';
  const failed = custom && faces.failed.includes(draft.font);
  const missing = useMissingGlyphs(draft.font, name, custom && !loading && !failed);
  const style = styleFrom(draft);

  return (
    <div className="name-style-editor">
      <NameStylePreviews
        guildId={guildId}
        config={config}
        read={read}
        style={style}
        name={name}
        loading={loading}
        failed={failed}
        missing={missing}
      />

      <section className="name-style-group" aria-labelledby={choiceId}>
        <h3 id={choiceId} className="name-style-heading">
          Style
        </h3>
        <RadioTiles
          labelledBy={choiceId}
          options={CHOICES}
          value={draft.kind}
          columns={2}
          className="name-style-choices"
          onChange={(kind) => onDraft(withChoice(draft, kind))}
        >
          {(kind) => (
            <>
              <span className="name-style-tile-label">{CHOICE_LABELS[kind]}</span>
              <span className="name-style-tile-typeface">{CHOICE_HINTS[kind]}</span>
            </>
          )}
        </RadioTiles>
      </section>

      <FontGrid
        value={custom ? draft.font : null}
        loading={loading}
        issue={issueAt(style, 'displayNameStyle.font')}
        onChange={(font) => onDraft(withFont(draft, font))}
      />
      <EffectGrid
        draft={draft}
        issue={issueAt(style, 'displayNameStyle.effect')}
        onChange={(effect) => onDraft(withEffect(draft, effect))}
      />
      {custom ? (
        <NameStyleColours
          draft={draft}
          issue={issueAt(style, 'displayNameStyle.colours')}
          onChange={onDraft}
        />
      ) : null}
    </div>
  );
}

export function NameStyleActions({
  canDone,
  onCancel,
  onDone,
}: {
  canDone: boolean;
  onCancel: () => void;
  onDone: () => void;
}): ReactElement {
  return (
    <>
      <Button onClick={onCancel}>Cancel</Button>
      <Button tone="primary" disabled={!canDone} onClick={onDone}>
        Done
      </Button>
    </>
  );
}

export function NameStyleDialog({
  open,
  onClose,
  guildId,
  config,
  read,
  value,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  guildId: string;
  config: BrandingConfig;
  read: AccountRead;
  value: DisplayNameStyle | null;
  onDone: (next: DisplayNameStyle | null) => void;
}): ReactElement | null {
  const [wasOpen, setWasOpen] = useState(open);
  const [draft, setDraft] = useState<NameStyleDraft>(() => draftFrom(value));

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(draftFrom(value));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      title={NAME_STYLE_DIALOG_TITLE}
      description={NAME_STYLE_DIALOG_DESCRIPTION}
      footer={
        <NameStyleActions
          canDone={canConfirm(draft, value)}
          onCancel={onClose}
          onDone={() => onDone(styleFrom(draft))}
        />
      }
    >
      <NameStyleEditor
        guildId={guildId}
        config={config}
        read={read}
        draft={draft}
        onDraft={setDraft}
      />
    </Dialog>
  );
}
