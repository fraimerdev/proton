import { type ReactElement, type ReactNode, useEffect, useId, useState } from 'react';
import { Icon } from '../shell/icon.tsx';

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

export interface SectionCardProps {
  id: string;
  title: string | null;
  children: ReactNode;
  edited?: boolean | undefined;
}

export function SectionCard({ id, title, children, edited }: SectionCardProps): ReactElement {
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
      <section className="form-section">
        <div className="form-section-body">{children}</div>
      </section>
    );
  }

  return (
    <section className="form-section">
      <h2 className="form-section-head">
        <button
          type="button"
          className="form-section-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span className="form-section-title">{title}</span>
          {/* The save bar says work is unsaved; on a collapsed card this says which one holds it. */}
          {edited ? <span className="form-section-edited">Edited</span> : null}
          <Icon name={collapsed ? 'caret-down' : 'caret-up'} className="form-section-caret" />
        </button>
      </h2>
      <div className="form-section-body" id={bodyId} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
