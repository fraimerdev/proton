import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './controls.tsx';
import { Icon } from './icon.tsx';
import { usePresence } from './overlay.tsx';

interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  /** Shown beside the label — a limit, a consequence, what the save will do. */
  note?: ReactNode;
  saveLabel?: string | undefined;
  disabled?: boolean | undefined;
}

const SAVED_HOLD_MS = 800;

export function SaveBar({
  dirty,
  saving,
  onSave,
  onReset,
  note,
  saveLabel = 'Save changes',
  disabled = false,
}: SaveBarProps): ReactElement | null {
  const noteId = useId();
  const bar = useRef<HTMLElement>(null);

  const [last, setLast] = useState({ dirty, saving });
  const [saved, setSaved] = useState(false);
  const [holding, setHolding] = useState(false);

  if (last.dirty !== dirty || last.saving !== saving) {
    setLast({ dirty, saving });
    if (dirty) {
      setSaved(false);
      setHolding(false);
    } else if (last.dirty && (last.saving || saving)) {
      setSaved(true);
      setHolding(true);
    }
  }

  useEffect(() => {
    if (!holding) return;

    const timer = window.setTimeout(() => setHolding(false), SAVED_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);

  // Leaving with unsaved edits is nearly always a slip. The browser owns the wording.
  useEffect(() => {
    if (!dirty) return;

    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const { present, leaving, onAnimationEnd } = usePresence(dirty || holding, bar);

  if (!present) return null;

  const toast = (
    <section
      ref={bar}
      className={cx('savebar', leaving && 'leaving', saved && 'saved')}
      aria-label="Unsaved changes"
      inert={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="savebar-title" aria-hidden={saved || undefined}>
        Careful, you have unsaved changes
      </div>
      {note !== undefined ? (
        <span id={noteId} className="visually-hidden">
          {note}
        </span>
      ) : null}
      <div className="savebar-actions">
        <Button tone="ghost" onClick={onReset} disabled={saving || saved}>
          Reset
        </Button>
        <Button
          tone="primary"
          className={cx('savebar-save', saved && 'saved')}
          onClick={onSave}
          busy={saving && !saved}
          disabled={disabled || saved}
          aria-describedby={note !== undefined ? noteId : undefined}
          title={typeof note === 'string' ? note : undefined}
        >
          {saved ? <Icon name="check" size={15} weight="fill" className="motion-pop" /> : null}
          {saveLabel}
        </Button>
      </div>
    </section>
  );

  return (
    <>
      <div className="savebar-spacer" aria-hidden />
      {/* Portalled: a transformed ancestor (the page transition) would otherwise capture position: fixed. */}
      {typeof document === 'undefined' ? toast : createPortal(toast, document.body)}
    </>
  );
}
