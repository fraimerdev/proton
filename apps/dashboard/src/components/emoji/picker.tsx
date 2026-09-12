import { parseComponentEmoji } from '@proton/core';
import { lazy, type ReactElement, Suspense, useCallback, useRef, useState } from 'react';
import { Popover } from '../form/picker.tsx';
import { useDismiss } from '../shell/dismiss.ts';
import { Icon } from '../shell/icon.tsx';
import { EmojiGlyph } from './glyph.tsx';

/**
 * Lazy on purpose. The panel carries the generated unicode set — 1900 emoji and their names, about
 * 95KB — and the trigger is imported by `form/fields.tsx`, which every module page pulls in. Loaded
 * eagerly the whole table would sit in the first chunk of a dashboard most visits never open a
 * picker on.
 */
const EmojiPanel = lazy(async () => ({ default: (await import('./panel.tsx')).EmojiPicker }));

export interface EmojiInputProps {
  value: string;
  onChange: (value: string) => void;
  // Off where the schema demands one — a ticket panel button with no emoji and no label is a button
  // Discord refuses.
  clearable?: boolean | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  name?: string | undefined;
}

// The search field, the nine-column grid and the preview bar. Asked for rather than measured: the
// panel is lazily loaded, so measuring it after it arrives would move it under the pointer.
const EMOJI_WANT = { width: 356, height: 420 };

/**
 * The trigger and its popover. Replaces the free-text boxes that asked an admin to paste
 * `<:name:123456789012345678>` from a Discord message and type a unicode emoji from their keyboard.
 */
export function EmojiInput({
  value,
  onChange,
  clearable = true,
  invalid,
  describedBy,
  name,
}: EmojiInputProps): ReactElement {
  const [open, setOpen] = useState(false);

  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // The popover is parented to the body, so it is the region that counts as inside — not the
  // wrapper this trigger sits in, which no longer contains the panel at all.
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, pop, trigger);

  const parsed = parseComponentEmoji(value);
  const label = parsed ? (parsed.id ? `:${parsed.name}:` : '') : 'Pick an emoji';

  return (
    <span className="emoji-input">
      <button
        ref={trigger}
        type="button"
        className="emoji-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-label={name}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="emoji-trigger-glyph">
          {value ? <EmojiGlyph value={value} size={20} /> : <Icon name="smiley" />}
        </span>
        {/* A unicode emoji is its own label, and printing the character twice — once as the glyph
            and once as the name beside it — is what the trigger did before this was empty. */}
        {label ? (
          <span className={`emoji-trigger-name${value ? '' : ' emoji-trigger-empty'}`}>
            {label}
          </span>
        ) : null}
        <Icon name="caret-down" className="emoji-trigger-caret" />
      </button>

      {value && clearable ? (
        <button
          type="button"
          className="emoji-clear"
          aria-label="Clear emoji"
          onClick={() => onChange('')}
        >
          <Icon name="x" />
        </button>
      ) : null}

      {open ? (
        <Popover anchor={trigger} popRef={pop} className="popover" want={EMOJI_WANT}>
          <Suspense fallback={<span className="emoji-panel-loading">Loading emoji…</span>}>
            <EmojiPanel
              value={value}
              panelRef={panel}
              onClose={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
              onSelect={(next) => {
                onChange(next);
                setOpen(false);
                trigger.current?.focus();
              }}
            />
          </Suspense>
        </Popover>
      ) : null}
    </span>
  );
}
