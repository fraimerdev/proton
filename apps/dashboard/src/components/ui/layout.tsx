import type { ReactElement, ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ModuleLink, type ModuleSearch } from '../module/route.tsx';
import { cx } from './controls.tsx';
import { Icon, type IconName } from './icon.tsx';

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const FOLD_SLACK_MS = 50;

function transitionMs(element: Element | null): number {
  if (element === null) return 0;

  const style = getComputedStyle(element);
  const longest = (list: string): number =>
    Math.max(0, ...list.split(',').map((part) => Number.parseFloat(part) * 1000 || 0));

  return longest(style.transitionDuration) + longest(style.transitionDelay);
}

/* ------------------------------------------------------------------ section */

export function Section({
  label,
  note,
  intro,
  actions,
  children,
  className,
}: {
  label?: string | undefined;
  note?: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return (
    <section className={cx('section', className)}>
      {label !== undefined || actions !== undefined ? (
        <div className="section-label">
          {label}
          {note !== undefined ? <span className="section-label-note">{note}</span> : null}
          {actions !== undefined ? <span className="push-right">{actions}</span> : null}
        </div>
      ) : null}
      {intro !== undefined ? <p className="section-intro">{intro}</p> : null}
      {children}
    </section>
  );
}

/** One restrained surface holding sibling rows, hairline-separated. Never a card per setting. */
export function Rows({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return <div className={cx('rows', className)}>{children}</div>;
}

/* -------------------------------------------------------------- setting row */

interface SettingRowProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Puts the control on its own line — for a control too wide to sit beside the copy. */
  stacked?: boolean | undefined;
  error?: string | undefined;
  note?: ReactNode;
  disabled?: boolean | undefined;
  badge?: ReactNode;
}

export function SettingRow({
  title,
  description,
  children,
  stacked = false,
  error,
  note,
  disabled = false,
  badge,
}: SettingRowProps): ReactElement {
  return (
    <div className={cx('row', stacked && 'stacked', disabled && 'disabled')}>
      <div className="row-main">
        <div className="row-title">
          {title}
          {badge}
        </div>
        {description !== undefined ? <p className="row-description">{description}</p> : null}
        {error !== undefined ? (
          <p className="row-error" role="alert">
            {error}
          </p>
        ) : note !== undefined ? (
          <p className="row-note">{note}</p>
        ) : null}
      </div>
      {children !== undefined ? <div className="row-control">{children}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------- navigation row */

interface NavigationRowBase {
  icon?: IconName | undefined;
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
}

/**
 * A whole row that navigates: chevron, no button. It links into the module route rather than
 * taking arbitrary link props, whose `title` collides with the anchor's own title attribute.
 */
export function NavigationRow({
  icon,
  title,
  description,
  aside,
  guildId,
  moduleId,
  search,
}: NavigationRowBase & {
  guildId: string;
  moduleId: string;
  search: ModuleSearch;
}): ReactElement {
  return (
    <ModuleLink guildId={guildId} moduleId={moduleId} search={search} className="nav-row">
      {icon ? <Icon name={icon} size={18} className="nav-row-icon" /> : null}
      <span className="row-main">
        <span className="row-title">{title}</span>
        {description !== undefined ? <span className="row-description">{description}</span> : null}
      </span>
      {aside}
      <Icon name="caret-right" size={15} className="nav-row-chevron" />
    </ModuleLink>
  );
}

/** A row whose action is explicit: a named button rather than a chevron. */
export function ActionRow({
  icon,
  title,
  description,
  children,
}: NavigationRowBase & { children: ReactNode }): ReactElement {
  return (
    <div className="nav-row">
      {icon ? <Icon name={icon} size={18} className="nav-row-icon" /> : null}
      <div className="row-main">
        <div className="row-title">{title}</div>
        {description !== undefined ? <p className="row-description">{description}</p> : null}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

/* --------------------------------------------------------- expandable row */

export function RowDetail({
  open,
  id,
  children,
}: {
  open: boolean;
  id?: string | undefined;
  children: ReactNode;
}): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const [present, setPresent] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [moving, setMoving] = useState(false);

  if (open !== wasOpen) {
    setWasOpen(open);
    setMoving(true);
    if (open) setPresent(true);
    else setExpanded(false);
  }

  // Folding keeps the last detail on screen; the caller has already stopped rendering it.
  const shown = useRef<ReactNode>(children);
  useIsomorphicLayoutEffect(() => {
    if (open) shown.current = children;
  });

  useIsomorphicLayoutEffect(() => {
    if (!open || expanded) return;
    // Reading layout commits the folded style first, so expanding transitions from it.
    panel.current?.getBoundingClientRect();
    setExpanded(true);
  }, [open, expanded]);

  useEffect(() => {
    if (open || !present) return;

    const timer = window.setTimeout(
      () => setPresent(false),
      transitionMs(panel.current) + FOLD_SLACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [open, present]);

  if (!present) return null;

  return (
    <div
      ref={panel}
      id={id}
      className="row-detail"
      data-expanded={expanded ? '' : undefined}
      data-moving={moving ? '' : undefined}
      inert={!open}
      onTransitionEnd={(event) => {
        if (open && expanded && event.target === event.currentTarget) setMoving(false);
      }}
    >
      <div className="row-detail-clip">
        <div className="row-detail-body">
          <div className="row-detail-inner">{open ? children : shown.current}</div>
        </div>
      </div>
    </div>
  );
}

interface ExpandableRowProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName | undefined;
  control: ReactNode;
  /** Rendered only while open, so a closed row costs nothing. */
  detail?: (() => ReactNode) | undefined;
  defaultOpen?: boolean | undefined;
  badge?: ReactNode;
  className?: string | undefined;
}

export function ExpandableRow({
  title,
  description,
  icon,
  control,
  detail,
  defaultOpen = false,
  badge,
  className,
}: ExpandableRowProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={className}>
      <div className="row-expandable">
        {icon ? <Icon name={icon} size={17} className="nav-row-icon" /> : null}
        <div className="row-main">
          <div className="row-title">
            {title}
            {badge}
          </div>
          {description !== undefined ? <p className="row-description">{description}</p> : null}
        </div>
        <div className="row-control">{control}</div>
        {detail ? (
          <button
            type="button"
            className="row-disclosure"
            aria-expanded={open}
            aria-controls={id}
            aria-label={open ? 'Hide settings' : 'Show settings'}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="caret-down" size={14} weight="fill" />
          </button>
        ) : null}
      </div>
      <RowDetail open={detail !== undefined && open} id={id}>
        {detail && open ? detail() : null}
      </RowDetail>
    </div>
  );
}

export function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="row-detail-field">
      <span className="row-detail-label">{label}</span>
      {children}
    </div>
  );
}

/** The sentence a tuned check actually enforces, beside its inputs. */
export function DetailExplain({ children }: { children: ReactNode }): ReactElement {
  return <p className="row-detail-explain">{children}</p>;
}

/* ---------------------------------------------------------------- key/value */

export function Pairs({ children }: { children: ReactNode }): ReactElement {
  return <div className="pairs">{children}</div>;
}

export function Pair({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <>
      <span className="pairs-label">{label}</span>
      <span>{children}</span>
    </>
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return <div className={cx('panel', className)}>{children}</div>;
}
