import {
  NAME_STYLE_COLOURS,
  NAME_STYLE_EFFECT_LABELS,
  toHexColour,
} from '@proton/module-branding/name-style';
import type { ReactElement } from 'react';
import { useId } from 'react';
import { ColourPicker } from '../../../components/discord/inputs.tsx';
import {
  activeColour,
  colourLabel,
  cssColour,
  NAME_STYLE_PRESETS,
  type NameStyleDraft,
  withActive,
  withColour,
} from './shape.ts';
import { RadioTiles } from './tiles.tsx';

const PRESET_VALUES = NAME_STYLE_PRESETS.map((preset) => preset.value);

export function NameStyleColours({
  draft,
  issue,
  onChange,
}: {
  draft: NameStyleDraft;
  issue?: string | undefined;
  onChange: (next: NameStyleDraft) => void;
}): ReactElement {
  const headingId = useId();
  const slotsId = useId();
  const presetsId = useId();

  const count = NAME_STYLE_COLOURS[draft.effect];
  const current = activeColour(draft);
  const slots = draft.slots.slice(0, count).map((_, index) => index);
  const pickerLabel = count === 1 ? 'Colour' : `Colour ${draft.active + 1}`;

  return (
    <section className="name-style-group" aria-labelledby={headingId}>
      <h3 id={headingId} className="name-style-heading">
        {count === 1 ? 'Colour' : 'Colours'}
      </h3>

      {count > 1 ? (
        <>
          <p id={slotsId} className="name-style-caption">
            {`${NAME_STYLE_EFFECT_LABELS[draft.effect]} uses ${count} colours. Choose one to change it.`}
          </p>
          <RadioTiles
            labelledBy={slotsId}
            options={slots}
            value={draft.active}
            className="name-style-swatches"
            tileClassName="name-style-swatch-tile"
            label={(index) => `Colour ${index + 1}, ${toHexColour(draft.slots[index] ?? current)}`}
            onChange={(index) => onChange(withActive(draft, index))}
          >
            {(index) => (
              <span
                className="name-style-swatch"
                style={{ background: cssColour(draft.slots[index] ?? current) }}
              />
            )}
          </RadioTiles>
        </>
      ) : null}

      <p id={presetsId} className="name-style-caption">
        {count === 1 ? 'Presets' : `Presets for colour ${draft.active + 1}`}
      </p>
      <RadioTiles
        labelledBy={presetsId}
        options={PRESET_VALUES}
        value={PRESET_VALUES.includes(current) ? current : null}
        className="name-style-swatches"
        tileClassName="name-style-swatch-tile"
        label={colourLabel}
        onChange={(value) => onChange(withColour(draft, value))}
      >
        {(value) => <span className="name-style-swatch" style={{ background: cssColour(value) }} />}
      </RadioTiles>

      <ColourPicker
        label={pickerLabel}
        value={current}
        onChange={(value) => onChange(withColour(draft, value))}
      />

      {issue !== undefined ? <p className="name-style-issue">{issue}</p> : null}
    </section>
  );
}
