import { type ReactElement, type ReactNode, useEffect, useId, useRef } from 'react';
import { useFocusTrap } from './dismiss.ts';

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;

  cancelLabel: string;
  confirmLabel: string;

  tone?: 'danger' | 'quiet';

  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  children,
  cancelLabel,
  confirmLabel,
  tone = 'danger',
  onCancel,
  onConfirm,
}: ConfirmDialogProps): ReactElement {
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();

  // aria-modal="true" is a promise to a screen reader that the rest of the page is out of reach.
  // Without this the second Tab lands on the page behind the scrim, still operable.
  useFocusTrap(dialog, true);

  // Focus lands on the safe choice, not on the page behind the dialog — a confirm nobody's keyboard
  // is inside is a confirm the next Enter or Tab goes around.
  useEffect(() => {
    const cameFrom = document.activeElement;

    cancel.current?.focus();

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (cameFrom instanceof HTMLElement && cameFrom.isConnected) cameFrom.focus();
    };
  }, [onCancel]);

  return (
    <div className="palette-scrim">
      <button
        type="button"
        className="palette-backdrop"
        aria-label={cancelLabel}
        tabIndex={-1}
        onClick={onCancel}
      />

      <div
        className="confirm"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
      >
        <h2 className="confirm-title" id={`${id}-title`}>
          {title}
        </h2>
        <p className="confirm-text" id={`${id}-text`}>
          {children}
        </p>
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="button button-quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={`button button-${tone}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
