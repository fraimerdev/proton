import { type RefObject, useEffect } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;

    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Tab' || !ref.current) return;

      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref, active]);
}

export function useDismiss(
  open: boolean,
  close: () => void,
  ref: RefObject<HTMLElement | null>,
  restoreTo?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        restoreTo?.current?.focus();
      }
    }

    // The trigger counts as inside. SinglePicker passes a wrapper that already contains its button,
    // but the shell's menu and drawer sit outside theirs — so a pointerdown on the trigger closed
    // here and the click that followed toggled a closed menu straight back open, which made the
    // account button and the drawer's own X unable to close what they had opened.
    function onPointer(event: MouseEvent): void {
      const target = event.target as Node | null;
      if (!target || !ref.current) return;
      if (ref.current.contains(target)) return;
      if (restoreTo?.current?.contains(target)) return;

      close();
    }

    // Tab is a dismissal too. A pointerdown-only rule left a picker's popover standing over the
    // rows below it once the keyboard had moved on. A null relatedTarget is the window losing
    // focus, not the user leaving, so it stays open.
    function onFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null;
      if (!next || !ref.current) return;
      if (ref.current.contains(next)) return;
      if (restoreTo?.current?.contains(next)) return;

      close();
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusout', onFocusOut);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [open, close, ref, restoreTo]);
}
