import { useBlocker } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './controls.tsx';
import { Icon } from './icon.tsx';
import { usePresence } from './overlay.tsx';

interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  // Bumped on every refused save, so a repeat of the same error still shakes.
  failures?: number | undefined;
  onSave: () => void;
  onReset: () => void;
  note?: ReactNode;
  saveLabel?: string | undefined;
  disabled?: boolean | undefined;
}

const SAVED_HOLD_MS = 1600;
const ALARM_HOLD_MS = 1600;

const SHAKE: Keyframe[] = [0, -10, 10, -8, 8, -4, 4, 0].map((x) => ({
  transform: `translateX(${x}px)`,
}));

export function SaveBar({
  dirty,
  saving,
  failures = 0,
  onSave,
  onReset,
  note,
  saveLabel = 'Save changes',
  disabled = false,
}: SaveBarProps): ReactElement | null {
  const noteId = useId();
  const bar = useRef<HTMLElement>(null);

  const [last, setLast] = useState({ dirty, saving, failures });
  const [saved, setSaved] = useState(false);
  const [holding, setHolding] = useState(false);
  const [alarm, setAlarm] = useState<{ count: number; reason: 'failed' | 'leaving' }>({
    count: 0,
    reason: 'failed',
  });
  const [calmed, setCalmed] = useState(0);
  const alarmed = alarm.count > calmed;

  if (last.dirty !== dirty || last.saving !== saving || last.failures !== failures) {
    setLast({ dirty, saving, failures });
    if (failures > last.failures) {
      setAlarm((current) => ({ count: current.count + 1, reason: 'failed' }));
    }
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

  useEffect(() => {
    if (alarm.count === 0) return;

    // Web Animations, not a class: a class that is already on cannot replay a shake.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      bar.current?.animate(SHAKE, {
        duration: 480,
        easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)',
      });
    }

    const timer = window.setTimeout(() => setCalmed(alarm.count), ALARM_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [alarm.count]);

  // Only a change of page is refused: areas and drill-downs are search params inside the same draft.
  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      setAlarm((previous) => ({ count: previous.count + 1, reason: 'leaving' }));
      return true;
    },
    disabled: !dirty,
    enableBeforeUnload: false,
  });

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
      className={cx('savebar', leaving && 'leaving', saved && 'saved', alarmed && 'alarmed')}
      aria-label={saved ? 'Changes saved' : 'Unsaved changes'}
      inert={leaving}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="savebar-text">
        <div className="savebar-title" aria-hidden={saved || undefined}>
          Careful, you have unsaved changes
        </div>
        {note !== undefined && disabled ? (
          <p id={noteId} className="savebar-note" aria-hidden={saved || undefined}>
            {note}
          </p>
        ) : null}
        {note !== undefined && !disabled ? (
          <span id={noteId} className="visually-hidden">
            {note}
          </span>
        ) : null}
      </div>
      <div className="savebar-actions" aria-hidden={saved || undefined}>
        <Button tone="ghost" onClick={onReset} disabled={saving || saved}>
          Reset
        </Button>
        <Button
          tone="primary"
          className="savebar-save"
          onClick={onSave}
          busy={saving && !saved}
          disabled={disabled || saved}
          title={typeof note === 'string' && !disabled ? note : undefined}
          aria-describedby={note !== undefined ? noteId : undefined}
        >
          {saveLabel}
        </Button>
      </div>
      <div className="savebar-done" role="status">
        {saved ? (
          <>
            <Icon name="check" size={16} weight="fill" className="motion-pop" />
            <span className="motion-enter">Changes saved successfully</span>
          </>
        ) : null}
      </div>
      <span className="visually-hidden" role="alert">
        {alarmed && alarm.reason === 'leaving'
          ? 'Save or reset your changes before leaving this page.'
          : null}
      </span>
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
