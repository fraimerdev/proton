import { type ReactElement, type ReactNode, useEffect, useId, useState } from 'react';
import { Icon } from '../shell/icon.tsx';
import type { IconName } from '../shell/icon-set.gen.ts';

const STORE_KEY = 'proton.collapsed-sections';

export function collapsedSections(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);

    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function remember(id: string, collapsed: boolean): void {
  const held = collapsedSections();

  if (collapsed) held.add(id);
  else held.delete(id);

  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify([...held]));
  } catch {
    return;
  }
}

/**
 * How wide a section wants to be in the settings grid. `half` is the default because most sections
 * hold two or three short fields and reading one per screen-height was the whole complaint; `full`
 * is for anything with its own editor, table or matrix inside it.
 */
export type SectionSpan = 'half' | 'full';

/**
 * The grid every module's settings sit in. Two columns from 1180px up, one below — sections opt
 * into spanning both. Declared here rather than per page so a module cannot invent its own gutter.
 */
export function SettingsGrid({ children }: { children: ReactNode }): ReactElement {
  return <div className="settings-grid">{children}</div>;
}

/**
 * Two or three controls that belong on one line — a min and a max, a colour and its label. Inside
 * a section body, so the row still carries the section's hairlines above and below it.
 */
export function FieldRow({ children }: { children: ReactNode }): ReactElement {
  return <div className="field-row">{children}</div>;
}

export type CalloutTone = 'info' | 'warn' | 'danger';

const CALLOUT_ICON: Record<CalloutTone, IconName> = {
  info: 'info',
  warn: 'warning',
  danger: 'warning-circle',
};

/**
 * A sentence the admin has to read before they change what is under it. Not a card: a callout that
 * looked like a section was read as another group of settings and skipped.
 */
export function Callout({
  tone = 'info',
  children,
}: {
  tone?: CalloutTone;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={`callout callout-${tone}`}>
      <Icon name={CALLOUT_ICON[tone]} weight="fill" />
      <div className="callout-text">{children}</div>
    </div>
  );
}

/**
 * A run of sections under one heading, spanning the grid. For a page with more structure than a
 * flat list of sections — the heading is the band, the sections inside it keep their own spans.
 */
export function SectionBand({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="band">
      <div className="band-head">
        <h2 className="band-title">{title}</h2>
        {hint ? <p className="band-hint">{hint}</p> : null}
      </div>
      <div className="settings-grid">{children}</div>
    </section>
  );
}

export interface SectionCardProps {
  id: string;
  title: string | null;
  hint?: string;
  span?: SectionSpan;
  aside?: ReactNode;
  children: ReactNode;
}

export function SectionCard({
  id,
  title,
  hint,
  span = 'half',
  aside,
  children,
}: SectionCardProps): ReactElement {
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(false);

  // Read after mount rather than seeded into useState: the server render cannot see localStorage,
  // and a seed it disagrees with hydrates into a mismatched tree.
  useEffect(() => setCollapsed(collapsedSections().has(id)), [id]);

  function toggle(): void {
    const next = !collapsed;

    setCollapsed(next);
    remember(id, next);
  }

  if (title === null) {
    return (
      <section className="form-section" data-span={span}>
        <div className="form-section-body">{children}</div>
      </section>
    );
  }

  return (
    <section className="form-section" data-span={span}>
      <div className="form-section-head">
        <h2 className="form-section-heading">
          <button
            type="button"
            className="form-section-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <Icon name={collapsed ? 'caret-right' : 'caret-down'} className="form-section-caret" />
            <span className="form-section-titling">
              <span className="form-section-title">{title}</span>
              {hint ? <span className="form-section-hint">{hint}</span> : null}
            </span>
          </button>
        </h2>

        {/* Outside the toggle, not inside it: a button nested in a button is not a button, and the
            section's own action was collapsing the section instead of running. */}
        {aside ? <div className="form-section-aside">{aside}</div> : null}
      </div>

      <div className="form-section-body" id={bodyId} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
