import type { AnimationEvent, ReactElement, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './controls.tsx';
import { Icon } from './icon.tsx';

// useLayoutEffect warns during SSR, and the first paint of a popover only ever happens after a
// click, so the effect that measures it never runs on the server anyway.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const EXIT_SLACK_MS = 50;

function animationMs(element: Element | null): number {
  if (element === null) return 0;

  const style = getComputedStyle(element);
  const longest = (list: string): number =>
    Math.max(0, ...list.split(',').map((part) => Number.parseFloat(part) * 1000 || 0));

  return longest(style.animationDuration) + longest(style.animationDelay);
}

export function usePresence(
  open: boolean,
  element: RefObject<HTMLElement | null>,
): {
  present: boolean;
  leaving: boolean;
  generation: number;
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
} {
  const [wasOpen, setWasOpen] = useState(open);
  const [present, setPresent] = useState(open);
  const [generation, setGeneration] = useState(0);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPresent(true);
      setGeneration((current) => current + 1);
    }
  }

  const leaving = present && !open;

  useEffect(() => {
    if (!leaving) return;

    // A hidden tab never delivers animationend, and a node left mounted there is a stuck overlay.
    const timer = window.setTimeout(
      () => setPresent(false),
      animationMs(element.current) + EXIT_SLACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [leaving, element]);

  const onAnimationEnd = (event: AnimationEvent<HTMLElement>): void => {
    if (leaving && event.target === event.currentTarget) setPresent(false);
  };

  return { present, leaving, generation, onAnimationEnd };
}

/* ------------------------------------------------------------------ popover */

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Matches the trigger's width, for a select-like picker. */
  matchWidth?: boolean | undefined;
  minWidth?: number | undefined;
  maxWidth?: number | undefined;
  align?: 'start' | 'end' | undefined;
  className?: string | undefined;
  labelledBy?: string | undefined;
}

const GAP = 4;
const EDGE = 8;

export function Popover({
  anchor,
  open,
  onClose,
  children,
  matchWidth = false,
  minWidth,
  maxWidth,
  align = 'start',
  className,
  labelledBy,
}: PopoverProps): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{
    top: number;
    left: number;
    width?: number;
    side: 'top' | 'bottom';
  }>({
    top: -9999,
    left: -9999,
    side: 'bottom',
  });

  const { present, leaving, generation, onAnimationEnd } = usePresence(open, panel);

  useIsomorphicLayoutEffect(() => {
    if (leaving && panel.current?.contains(document.activeElement)) anchor.current?.focus();
  }, [leaving, anchor]);

  // Pickers clear their search as they close; the closing panel keeps the list the admin saw.
  const shown = useRef<ReactNode>(children);
  useIsomorphicLayoutEffect(() => {
    if (open) shown.current = children;
  });

  const place = useCallback(() => {
    const trigger = anchor.current;
    const element = panel.current;
    if (!trigger || !element) return;

    const rect = trigger.getBoundingClientRect();
    // Offsets, not a rect: the entrance animation scales the panel, and a scaled width shifts an end-aligned one.
    const size = { width: element.offsetWidth, height: element.offsetHeight };

    const width = matchWidth ? rect.width : size.width;
    // The root's client box, not innerWidth: the stable scrollbar gutter sits inside innerWidth.
    const viewport = document.documentElement;

    const below = viewport.clientHeight - rect.bottom;
    const flip = below < size.height + GAP + EDGE && rect.top > below;
    const side = flip ? 'top' : 'bottom';

    const top = flip ? Math.max(EDGE, rect.top - size.height - GAP) : rect.bottom + GAP;

    const wanted = align === 'end' ? rect.right - width : rect.left;
    const edge = viewport.clientWidth - width - EDGE;
    const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, edge));

    setStyle(matchWidth ? { top, left, width: rect.width, side } : { top, left, side });
  }, [anchor, align, matchWidth]);

  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!present) return;

    const onScrollOrResize = (): void => place();
    // Capture, so a scroll inside any ancestor repositions it rather than leaving it behind.
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);

    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [present, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        anchor.current?.focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    // Capture, so a popover inside a Dialog claims Escape before the Dialog's own listener sees it.
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose, anchor]);

  if (!present || typeof document === 'undefined') return null;

  return createPortal(
    <div
      key={generation}
      ref={panel}
      role="group"
      className={cx('popover', leaving && 'leaving', className)}
      data-side={style.side}
      aria-labelledby={labelledBy}
      inert={leaving}
      onAnimationEnd={onAnimationEnd}
      style={{
        top: style.top,
        left: style.left,
        width: style.width,
        minWidth,
        maxWidth,
      }}
    >
      {open ? children : shown.current}
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------------- menu */

export interface MenuAction {
  id: string;
  label: string;
  icon?: Parameters<typeof Icon>[0]['name'] | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export function MenuButton({
  actions,
  label = 'More actions',
  align = 'end',
  size = 'sm',
}: {
  actions: readonly MenuAction[];
  label?: string | undefined;
  align?: 'start' | 'end' | undefined;
  size?: 'sm' | 'md' | undefined;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        ref={anchor}
        tone="ghost"
        size={size}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="dots-three-vertical" size={16} weight="fill" />
      </Button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        minWidth={176}
      >
        <div role="menu">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={action.disabled === true}
              className={cx('menu-item', action.danger === true && 'menu-item-danger')}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.icon ? <Icon name={action.icon} size={15} /> : null}
              {action.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------- dialog */

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'wide' | 'editor' | undefined;
  /** Shown at the left of the footer — a limit, a consequence, a count. */
  footerNote?: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'sm',
  footerNote,
}: DialogProps): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  const { present, leaving, generation, onAnimationEnd } = usePresence(open, panel);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!event.defaultPrevented) onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // A dialog that lets focus walk behind it is a dialog the keyboard cannot leave sensibly.
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      panel.current
        ?.querySelector<HTMLElement>('input, textarea, select, button:not([aria-label="Close"])')
        ?.focus();
    }, 0);

    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open, onClose]);

  const content = (
    <>
      <div className="dialog-head">
        <div className="dialog-title">
          {title}
          {description !== undefined ? <p className="dialog-description">{description}</p> : null}
        </div>
        <Button tone="ghost" size="sm" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={15} weight="fill" />
        </Button>
      </div>
      {children !== undefined ? <div className="dialog-body">{children}</div> : null}
      {footer !== undefined ? (
        <div className="dialog-foot">
          {footerNote !== undefined ? <span className="dialog-foot-note">{footerNote}</span> : null}
          {footer}
        </div>
      ) : null}
    </>
  );

  // Closing resets the parent's draft and busy state; the panel fades out showing what was confirmed.
  const shown = useRef<ReactNode>(content);
  useIsomorphicLayoutEffect(() => {
    if (open) shown.current = content;
  });

  if (!present || typeof document === 'undefined') return null;

  return createPortal(
    <div
      key={generation}
      className={cx('dialog-scrim', leaving && 'leaving')}
      onPointerDown={(event) => {
        if (!leaving && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('dialog', size !== 'sm' && size, leaving && 'leaving')}
        inert={leaving}
        onAnimationEnd={onAnimationEnd}
      >
        {open ? content : shown.current}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  danger = false,
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  confirmLabel: string;
  danger?: boolean | undefined;
  busy?: boolean | undefined;
  children: ReactNode;
}): ReactElement | null {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-secondary text-sm">{children}</p>
    </Dialog>
  );
}
