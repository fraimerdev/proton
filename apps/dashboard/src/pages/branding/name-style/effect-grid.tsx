import {
  isEffectAvailable,
  NAME_STYLE_EFFECT_LABELS,
  NAME_STYLE_EFFECTS,
  NAME_STYLE_UNAVAILABLE_NOTE,
  type NameStyleEffect,
} from '@proton/module-branding/name-style';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { type NameStyleDraft, slotColours } from './shape.ts';
import { NameSpecimen } from './specimen.tsx';
import { RadioTiles } from './tiles.tsx';

function unavailableNote(effect: NameStyleEffect): string | undefined {
  return isEffectAvailable(effect) ? undefined : NAME_STYLE_UNAVAILABLE_NOTE;
}

export function EffectGrid({
  draft,
  issue,
  onChange,
}: {
  draft: NameStyleDraft;
  issue?: string | undefined;
  onChange: (effect: NameStyleEffect) => void;
}): ReactElement {
  const headingId = useId();

  return (
    <section className="name-style-group" aria-labelledby={headingId}>
      <h3 id={headingId} className="name-style-heading">
        Choose effect
      </h3>

      <RadioTiles
        labelledBy={headingId}
        options={NAME_STYLE_EFFECTS}
        value={draft.kind === 'none' ? null : draft.effect}
        columns={4}
        className="name-style-grid"
        disabled={(effect) => !isEffectAvailable(effect)}
        note={unavailableNote}
        onChange={onChange}
      >
        {(effect) => (
          <>
            <span className="name-style-tile-sample" aria-hidden>
              <NameSpecimen
                font={draft.font}
                effect={effect}
                colours={slotColours(draft, effect)}
                text="Aa"
              />
            </span>
            <span className="name-style-tile-label">{NAME_STYLE_EFFECT_LABELS[effect]}</span>
          </>
        )}
      </RadioTiles>

      {issue !== undefined ? <p className="name-style-issue">{issue}</p> : null}
    </section>
  );
}
