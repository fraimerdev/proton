import {
  type DisplayNameStyle,
  NAME_STYLE_EFFECT_LABELS,
} from '@proton/module-branding/name-style';
import type { ReactElement } from 'react';
import { AppTag } from '../../../components/discord/identity.tsx';
import { Button } from '../../../components/ui/controls.tsx';
import { Spinner } from '../../../components/ui/feedback.tsx';
import { faceFor, faceSummary } from './faces.ts';
import { useFaces, useMissingGlyphs } from './load-face.ts';
import { issueAt } from './shape.ts';
import { NameSpecimen } from './specimen.tsx';
import { type NameStyleStatusCopy, NameStyleStatusLine } from './status.tsx';

export const NO_STYLE = 'No style';

export function nameStyleSummary(style: DisplayNameStyle | null): string {
  if (style === null) return NO_STYLE;
  return `${faceSummary(faceFor(style.font))} · ${NAME_STYLE_EFFECT_LABELS[style.effect]}`;
}

export function NameStyleCard({
  style,
  name,
  status,
  shows,
  onCustomise,
  onRemove,
}: {
  style: DisplayNameStyle | null;
  name: string;
  status: NameStyleStatusCopy | null;
  shows: string | null;
  onCustomise: () => void;
  onRemove: () => void;
}): ReactElement {
  const font = style?.font ?? 'gg-sans';
  const faces = useFaces(style === null ? [] : [font, 'gg-sans'], name);
  const missing = useMissingGlyphs(font, name, style !== null && faces.status === 'ready');
  const flag = issueAt(style, 'displayNameStyle.font') ?? issueAt(style, 'displayNameStyle.effect');

  return (
    <div className="name-style-card">
      <div className="dc name-style-card-specimen">
        {style === null ? (
          <span className="name-style-card-plain">{name}</span>
        ) : (
          <NameSpecimen
            font={style.font}
            effect={style.effect}
            colours={style.colours}
            text={name}
            missing={missing}
          />
        )}
        <AppTag />
        {style !== null && faces.status === 'loading' ? (
          <Spinner size="sm" status label="Loading the font" />
        ) : null}
      </div>

      <div className="name-style-card-main">
        <p className="name-style-card-summary">{nameStyleSummary(style)}</p>
        {flag !== undefined && flag !== status?.text ? (
          <p className="name-style-card-flag">{flag}</p>
        ) : null}
        <p className="name-style-card-state" aria-live="polite">
          <NameStyleStatusLine copy={status} />
        </p>
        {shows !== null ? <p className="name-style-card-shows">{shows}</p> : null}
      </div>

      <div className="name-style-card-actions">
        <Button onClick={onCustomise}>Customise</Button>
        {style !== null ? (
          <Button tone="ghost" onClick={onRemove}>
            Remove style
          </Button>
        ) : null}
      </div>
    </div>
  );
}
