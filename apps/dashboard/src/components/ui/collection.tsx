import type { AnimationEvent, ReactElement, ReactNode } from 'react';
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { ModuleLink, type ModuleSearch } from '../module/route.tsx';
import { cx } from './controls.tsx';
import { Icon, type IconName } from './icon.tsx';

const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const RECENT_HOLD_MS = 1000;
const LEAVE_FALLBACK_MS = 400;

type RecentKey = string | number;

export function useRecent(): {
  mark: (...keys: RecentKey[]) => void;
  has: (key: RecentKey) => boolean;
  enter: (key: RecentKey, kind?: 'item' | 'part') => string | undefined;
} {
  const [recent, setRecent] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (recent.size === 0) return;

    const timer = window.setTimeout(() => setRecent(new Set()), RECENT_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [recent]);

  const has = (key: RecentKey): boolean => recent.has(String(key));

  return {
    mark: (...keys) => setRecent((current) => new Set([...current, ...keys.map(String)])),
    has,
    enter: (key, kind = 'item') => (has(key) ? `motion-enter arrive-${kind}` : undefined),
  };
}

interface Presence {
  key: string;
  node: ReactElement;
  leaving: boolean;
}

// Children must be keyed by a stable id: keyed by index, the last row would leave instead.
export function PresenceList({ children }: { children: ReactNode }): ReactElement {
  const shown = useRef<readonly Presence[]>([]);
  const [, settle] = useReducer((count: number) => count + 1, 0);

  const incoming = Children.toArray(children).filter(isValidElement);
  const live = new Set(incoming.map((node) => String(node.key)));
  const present: Presence[] = incoming.map((node) => ({
    key: String(node.key),
    node,
    leaving: false,
  }));

  shown.current.forEach((item, at) => {
    if (!live.has(item.key)) present.splice(at, 0, { ...item, leaving: true });
  });

  useIsomorphicLayoutEffect(() => {
    shown.current = present;
  });

  const leaving = present.some((item) => item.leaving);

  useEffect(() => {
    if (!leaving) return;

    // A hidden tab never delivers animationend, and a row left mounted there never goes.
    const timer = window.setTimeout(() => {
      shown.current = shown.current.filter((item) => !item.leaving);
      settle();
    }, LEAVE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const release =
    (key: string) =>
    (event: AnimationEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) return;
      shown.current = shown.current.filter((item) => item.key !== key || !item.leaving);
      settle();
    };

  return (
    <>
      {present.map((item) => (
        <div
          key={item.key}
          className="presence"
          data-leaving={item.leaving ? '' : undefined}
          inert={item.leaving}
          onAnimationEnd={item.leaving ? release(item.key) : undefined}
        >
          <div className="presence-clip">{item.node}</div>
        </div>
      ))}
    </>
  );
}

/**
 * Ambient, not a paywall: the ceiling is what this server's tier actually allows, shown beside the
 * thing it limits so the number is legible before the Add button refuses.
 */
export function LimitCounter({
  used,
  ceiling,
  label,
}: {
  used: number;
  ceiling: number;
  label?: string | undefined;
}): ReactElement {
  const atLimit = used >= ceiling;

  return (
    <span
      className={cx('limit-counter', atLimit && 'at-limit')}
      title={label !== undefined ? `${used} of ${ceiling} ${label}` : undefined}
    >
      {used} / {ceiling}
    </span>
  );
}

export function CollectionHeader({
  title,
  used,
  ceiling,
  limitLabel,
  actions,
}: {
  title: ReactNode;
  used?: number | undefined;
  ceiling?: number | undefined;
  limitLabel?: string | undefined;
  actions?: ReactNode;
}): ReactElement {
  return (
    <div className="collection-head">
      <div className="collection-head-main">
        <h2 className="collection-title">{title}</h2>
        {used !== undefined && ceiling !== undefined ? (
          <LimitCounter used={used} ceiling={ceiling} label={limitLabel} />
        ) : null}
      </div>
      {actions !== undefined ? <div className="inline inline-8">{actions}</div> : null}
    </div>
  );
}

interface CollectionRowContent {
  icon?: IconName | undefined;
  glyph?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  aside?: ReactNode;
}

function RowInner({ icon, glyph, title, meta, badge, aside }: CollectionRowContent): ReactElement {
  return (
    <>
      {icon || glyph ? (
        <span className="collection-row-icon">
          {glyph ?? (icon ? <Icon name={icon} size={17} /> : null)}
        </span>
      ) : null}
      <span className="collection-row-main">
        <span className="collection-row-title">
          <span className="truncate">{title}</span>
          {badge}
        </span>
        {meta !== undefined ? <span className="collection-row-meta">{meta}</span> : null}
      </span>
      {aside !== undefined ? <span className="collection-row-aside">{aside}</span> : null}
    </>
  );
}

/**
 * A row that opens its own workspace. It links into the module route rather than taking arbitrary
 * link props: spreading a generic LinkProps made `title` collide with the anchor's own title
 * attribute and lost the typing of `params`.
 */
export function CollectionLinkRow({
  guildId,
  moduleId,
  search,
  selected = false,
  ...content
}: CollectionRowContent & {
  guildId: string;
  moduleId: string;
  search: ModuleSearch;
  selected?: boolean | undefined;
}): ReactElement {
  return (
    <ModuleLink
      guildId={guildId}
      moduleId={moduleId}
      search={search}
      className={cx('collection-row', selected && 'selected')}
      aria-current={selected ? 'true' : undefined}
    >
      <RowInner {...content} />
      <Icon name="caret-right" size={15} className="nav-row-chevron" />
    </ModuleLink>
  );
}

/** A row that selects into a detail pane beside the list. */
export function CollectionButtonRow({
  onSelect,
  selected = false,
  ...content
}: CollectionRowContent & {
  onSelect: () => void;
  selected?: boolean | undefined;
}): ReactElement {
  return (
    <button
      type="button"
      className={cx('collection-row', selected && 'selected')}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <RowInner {...content} />
      <Icon name="caret-right" size={15} className="nav-row-chevron" />
    </button>
  );
}

/** A row that is not itself navigational — its actions live on the right. */
export function CollectionStaticRow(
  content: CollectionRowContent & { className?: string | undefined },
): ReactElement {
  const { className, ...rest } = content;

  return (
    <div className={cx('collection-row', className)}>
      <RowInner {...rest} />
    </div>
  );
}

export function MetaSeparator(): ReactElement {
  return <span className="sep">·</span>;
}
