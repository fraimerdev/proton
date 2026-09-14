import {
  isFontAvailable,
  NAME_STYLE_FONTS,
  NAME_STYLE_UNAVAILABLE_NOTE,
  type NameStyleFont,
} from '@proton/module-branding/name-style';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { Spinner } from '../../../components/ui/feedback.tsx';
import { faceCaption, faceFor, fontStack } from './faces.ts';
import { RadioTiles } from './tiles.tsx';

function unavailableNote(font: NameStyleFont): string | undefined {
  return isFontAvailable(font) ? undefined : NAME_STYLE_UNAVAILABLE_NOTE;
}

export function FontGrid({
  value,
  loading,
  issue,
  onChange,
}: {
  value: NameStyleFont | null;
  loading: boolean;
  issue?: string | undefined;
  onChange: (font: NameStyleFont) => void;
}): ReactElement {
  const headingId = useId();
  const chosen = value === null ? null : faceFor(value);

  return (
    <section className="name-style-group" aria-labelledby={headingId}>
      <div className="name-style-heading-row">
        <h3 id={headingId} className="name-style-heading">
          Choose font
        </h3>
        {loading ? <Spinner size="sm" status label="Loading fonts" /> : null}
      </div>

      <RadioTiles
        labelledBy={headingId}
        options={NAME_STYLE_FONTS}
        value={value}
        columns={4}
        className="name-style-grid"
        disabled={(slug) => !isFontAvailable(slug)}
        note={unavailableNote}
        onChange={onChange}
      >
        {(slug) => {
          const face = faceFor(slug);

          return (
            <>
              <span
                className="name-style-tile-label name-style-tile-face"
                style={{ fontFamily: fontStack(slug), fontWeight: face.weight }}
              >
                {face.label}
              </span>
              {isFontAvailable(slug) ? (
                <span className="name-style-tile-typeface">{faceCaption(face)}</span>
              ) : null}
            </>
          );
        }}
      </RadioTiles>

      {issue !== undefined ? (
        <p className="name-style-issue">{issue}</p>
      ) : chosen !== null ? (
        <p className="name-style-caption">{`${chosen.label} · ${faceCaption(chosen)}`}</p>
      ) : null}
    </section>
  );
}
