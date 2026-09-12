import { BUTTON_STYLES, type ButtonStyle } from '@proton/core';
import { type ReactElement, useId } from 'react';
import { EmojiGlyph } from '../emoji/glyph.tsx';
import { EmojiInput } from '../emoji/picker.tsx';

const STYLE_LABELS: Record<ButtonStyle, string> = {
  primary: 'Blurple',
  secondary: 'Grey',
  success: 'Green',
  danger: 'Red',
  link: 'Link — opens a URL instead of doing something here',
};

export interface ButtonFaceProps {
  label: string;
  emoji: string;
  style: ButtonStyle;

  // Which styles this button may take. Verification's panel button leaves out `link`, because a
  // link button carries no custom_id and so never comes back to Proton.
  styles?: readonly ButtonStyle[];
  max: number;
  disabled?: boolean;

  labelInvalid?: boolean;
  emojiInvalid?: boolean;

  // Stamped on each cell so the command palette can jump to one of the three. Omitted where the
  // control is nested inside a panel the palette does not index.
  paths?: { label?: string; emoji?: string; style?: string };

  onLabel: (value: string) => void;
  onEmoji: (value: string) => void;
  onStyle: (style: ButtonStyle) => void;
}

/**
 * The three things that decide what a button looks like, on one row, over a preview of the result.
 * They were a select, a counted text box and an emoji field stacked among the button's key, its
 * disabled switch and its action — so the parts that make the button were never on screen together,
 * and the result was only visible in the whole-message preview beside the page.
 */
export function ButtonFace({
  label,
  emoji,
  style,
  styles = BUTTON_STYLES,
  max,
  disabled,
  labelInvalid,
  emojiInvalid,
  paths,
  onLabel,
  onEmoji,
  onStyle,
}: ButtonFaceProps): ReactElement {
  const group = useId();
  const over = label.length > max;

  return (
    <div className="button-face">
      <div className="button-face-controls">
        <span className="button-face-cell" data-path={paths?.emoji}>
          <span className="button-face-label">Emoji</span>
          <EmojiInput value={emoji} name="Button emoji" invalid={emojiInvalid} onChange={onEmoji} />
        </span>

        <label className="button-face-cell button-face-text" data-path={paths?.label}>
          <span className="button-face-label">Label</span>
          <input
            type="text"
            value={label}
            placeholder="Press me"
            aria-invalid={over || labelInvalid}
            onChange={(event) => onLabel(event.target.value)}
          />
          {label === '' ? null : (
            <span className="button-face-count num" data-over={over || undefined}>
              {label.length}/{max}
            </span>
          )}
        </label>

        <fieldset className="button-face-cell button-face-styles" data-path={paths?.style}>
          <legend className="button-face-label">Colour</legend>
          {styles.map((option) => (
            <label
              key={option}
              className="button-swatch"
              data-style={option}
              data-current={style === option ? 'true' : undefined}
              title={STYLE_LABELS[option]}
            >
              <input
                type="radio"
                name={group}
                checked={style === option}
                onChange={() => onStyle(option)}
              />
              <span className="sr-only">{STYLE_LABELS[option]}</span>
              {option === 'link' ? (
                <span className="dc-button-external" aria-hidden="true" />
              ) : null}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="button-face-preview">
        <span className="button-face-label">Preview</span>
        {/* The classes the message preview draws with, so this is the button rather than a
            drawing of one. */}
        <span className={`dc-button dc-button-${style}`} data-disabled={disabled || undefined}>
          {emoji ? <EmojiGlyph value={emoji} size={18} /> : null}
          {label ? <span>{label}</span> : null}
          {emoji === '' && label === '' ? (
            <span className="button-face-blank">No label yet</span>
          ) : null}
          {style === 'link' ? <span className="dc-button-external" aria-hidden="true" /> : null}
        </span>
      </div>
    </div>
  );
}
