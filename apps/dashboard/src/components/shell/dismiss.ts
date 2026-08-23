import { type RefObject, useEffect } from 'react';

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

    function onPointer(event: MouseEvent): void {
      const target = event.target as Node | null;
      if (target && ref.current && !ref.current.contains(target)) close();
    }

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close, ref, restoreTo]);
}
