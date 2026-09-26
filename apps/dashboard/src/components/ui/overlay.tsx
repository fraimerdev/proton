import type { AnimationEvent, ReactElement, ReactNode, RefObject } from 'react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './controls.tsx';
import { Icon, type IconName } from './icon.tsx';

// useLayoutEffect warns during SSR, and a popover is only ever measured after a click.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const subscribeToNothing = (): (() => void) => () => undefined;

// False on the server and while hydrating: a portal there is markup the server never sent.
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

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

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
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
    width?: number | undefined;
    maxHeight?: number | undefined;
    side: 'top' | 'bottom';
  }>({
    top: -9999,
    left: -9999,
    side: 'bottom',
  });

  const { present, leaving, generation, onAnimationEnd } = usePresence(open, panel);
  const hydrated = useHydrated();
  const mounted = present && hydrated;

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
    // Measured uncapped: a panel still capped for the cramped side would never flip to the roomier one.
    const capped = element.style.maxHeight;
    element.style.maxHeight = '';
    // Offsets, not a rect: the entrance animation scales the panel, and a scaled width shifts an end-aligned one.
    const size = { width: element.offsetWidth, height: element.offsetHeight };
    element.style.maxHeight = capped;

    const width = matchWidth ? rect.width : size.width;
    // The root's client box, not innerWidth: the stable scrollbar gutter sits inside innerWidth.
    const viewport = document.documentElement;

    const below = viewport.clientHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    const flip = size.height > below && above > below;
    const side = flip ? 'top' : 'bottom';
    const room = flip ? above : below;
    const height = Math.min(size.height, room);

    const top = flip ? Math.max(EDGE, rect.top - height - GAP) : rect.bottom + GAP;
    const maxHeight = size.height > room ? room : undefined;

    const wanted = align === 'end' ? rect.right - width : rect.left;
    const edge = viewport.clientWidth - width - EDGE;
    const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, edge));

    setStyle({ top, left, width: matchWidth ? rect.width : undefined, maxHeight, side });
  }, [anchor, align, matchWidth]);

  useIsomorphicLayoutEffect(() => {
    if (!open || !hydrated) return;
    place();
  }, [open, hydrated, place]);

  const closeLatest = useRef({ open, onClose });
  useIsomorphicLayoutEffect(() => {
    closeLatest.current = { open, onClose };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel remounts under key={generation}, and the new node has to be observed
  useEffect(() => {
    if (!mounted) return;

    const onScrollOrResize = (): void => {
      const trigger = anchor.current;
      const body = trigger?.closest('.dialog-body');
      if (trigger && body && closeLatest.current.open) {
        const at = trigger.getBoundingClientRect();
        const visible = body.getBoundingClientRect();
        // A trigger scrolled out of a dialog's body would leave its panel floating over the header or footer.
        if (at.bottom <= visible.top || at.top >= visible.bottom) {
          closeLatest.current.onClose();
          return;
        }
      }
      place();
    };
    // Capture, so a scroll inside any ancestor repositions it rather than leaving it behind.
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);

    const observer = new ResizeObserver(() => place());
    if (panel.current) observer.observe(panel.current);

    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      observer.disconnect();
    };
  }, [mounted, place, generation]);

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

  if (!mounted) return null;

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
        maxHeight: style.maxHeight,
        minWidth: minWidth === undefined ? undefined : `min(${minWidth}px, 100% - ${EDGE * 2}px)`,
        maxWidth:
          maxWidth === undefined
            ? `calc(100% - ${EDGE * 2}px)`
            : `min(${maxWidth}px, 100% - ${EDGE * 2}px)`,
      }}
    >
      {open ? children : shown.current}
    </div>,
    document.body,
  );
}

const HELP_STOPS = 'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function HelpTip({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      const inside = panel.current;
      if (event.key !== 'Tab' || !inside?.contains(document.activeElement)) return;

      const stops = [...inside.querySelectorAll<HTMLElement>(HELP_STOPS)];
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? at - 1 : at + 1;
      if (next >= 0 && next < stops.length) return;

      event.preventDefault();
      setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('help-tip', className)}
        aria-label={`More about ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="question" size={12} weight="fill" />
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={200}
        maxWidth={320}
        labelledBy={`${id}-label`}
      >
        <div ref={panel} id={id} className="help-tip-panel" tabIndex={-1}>
          <span id={`${id}-label`} className="visually-hidden">
            {label}
          </span>
          {children}
        </div>
      </Popover>
    </>
  );
}

export const MENU_ITEM = '[role="menuitem"]:not(:disabled)';

export function menuItemFor(items: HTMLElement[], key: string): HTMLElement | undefined {
  const current = items.indexOf(document.activeElement as HTMLElement);

  if (key === 'ArrowDown') return items[(current + 1) % items.length];
  if (key === 'ArrowUp') return items[current <= 0 ? items.length - 1 : current - 1];
  if (key === 'Home') return items[0];
  if (key === 'End') return items[items.length - 1];
  return undefined;
}

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
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(MENU_ITEM)?.focus({ preventScroll: true });
  }, [open]);

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
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              setOpen(false);
              return;
            }

            const items = [...(menu.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])];
            const target = menuItemFor(items, event.key);
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
        >
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

export type DialogSize = 'compact' | 'medium' | 'large';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size: DialogSize;
  icon?: IconName | undefined;
  tone?: 'danger' | undefined;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  footerNote?: ReactNode;
  dismissible?: boolean | undefined;
}

export function Dialog({
  open,
  onClose,
  title,
  size,
  icon,
  tone,
  description,
  children,
  footer,
  footerNote,
  dismissible = true,
}: DialogProps): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { present, leaving, generation, onAnimationEnd } = usePresence(open, panel);
  const hydrated = useHydrated();
  const showing = open && hydrated;
  // Read through a ref: callers pass a fresh onClose every render, and re-running the effect moves focus.
  const latest = useRef({ onClose, dismissible });
  useIsomorphicLayoutEffect(() => {
    latest.current = { onClose, dismissible };
  });

  useEffect(() => {
    if (!showing) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (latest.current.dismissible && !event.defaultPrevented) latest.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;

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
  }, [showing]);

  const content = (
    <>
      <div className="dialog-head">
        <div className="dialog-heading">
          {icon !== undefined ? (
            <span className={cx('dialog-icon', tone === 'danger' && 'danger')} aria-hidden="true">
              <Icon name={icon} size={16} weight="fill" />
            </span>
          ) : null}
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <Button
            tone="ghost"
            size="sm"
            aria-label="Close"
            className="dialog-close"
            disabled={!dismissible}
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </Button>
        </div>
        {description !== undefined ? (
          <div id={descriptionId} className="dialog-description">
            {description}
          </div>
        ) : null}
      </div>
      {children !== undefined ? <div className="dialog-body scroll-y">{children}</div> : null}
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

  if (!present || !hydrated) return null;

  return createPortal(
    <div
      key={generation}
      className={cx('dialog-scrim', leaving && 'leaving')}
      onPointerDown={(event) => {
        if (dismissible && !leaving && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        className={cx('dialog', size, leaving && 'leaving')}
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
  icon,
  danger = false,
  busy = false,
  dismissible = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  confirmLabel: string;
  icon?: IconName | undefined;
  danger?: boolean | undefined;
  busy?: boolean | undefined;
  dismissible?: boolean | undefined;
  children: ReactNode;
}): ReactElement | null {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="compact"
      icon={icon ?? (danger ? 'warning' : undefined)}
      tone={danger ? 'danger' : undefined}
      dismissible={dismissible}
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
