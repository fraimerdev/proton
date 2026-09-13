import type { ModuleSummary } from '@proton/core';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MODULES, NAV_GROUPS, type NavGroupId, RECORD_LINKS } from '../../lib/modules/catalogue.ts';
import { searchModules } from '../../lib/modules/search.ts';
import { ModuleLink } from '../module/route.tsx';
import { cx, SearchField } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';

function ModuleNavItem({
  guildId,
  moduleId,
  label,
  icon,
  hint,
  onNavigate,
}: {
  guildId: string;
  moduleId: string;
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  hint?: string | undefined;
  onNavigate?: (() => void) | undefined;
}): ReactElement {
  return (
    <ModuleLink
      guildId={guildId}
      moduleId={moduleId}
      search={{ area: undefined }}
      className="sidebar-item"
      activeOptions={{ exact: false, includeSearch: false }}
      onClick={onNavigate}
    >
      <Icon name={icon} size={16} className="sidebar-item-icon" />
      <span className="sidebar-item-label">
        {label}
        {hint !== undefined ? <span className="text-muted text-xs"> · {hint}</span> : null}
      </span>
    </ModuleLink>
  );
}

export function Sidebar({
  guildId,
  modules,
  open,
  onNavigate,
}: {
  guildId: string;
  modules: readonly ModuleSummary[];
  open: boolean;
  onNavigate?: (() => void) | undefined;
}): ReactElement {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => searchModules(query, modules), [query, modules]);
  const searching = query.trim() !== '';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      search.current?.focus();
      search.current?.select();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<NavGroupId, typeof MODULES>();
    for (const group of NAV_GROUPS) map.set(group.id, []);

    for (const meta of MODULES) {
      const list = map.get(meta.group);
      if (list) map.set(meta.group, [...list, meta]);
    }

    return map;
  }, []);

  return (
    <nav className={cx('sidebar', open && 'open')} aria-label="Modules">
      <div className="sidebar-inner">
        <div className="sidebar-search">
          <SearchField
            ref={search}
            value={query}
            onChange={setQuery}
            placeholder="Search settings…"
            label="Search modules and settings"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
          />
        </div>

        <div className="sidebar-scroll scroll-y">
          {searching ? (
            <>
              {hits.modules.length === 0 && hits.records.length === 0 ? (
                <p className="sidebar-empty">
                  No matching modules or settings for “{query.trim()}”
                </p>
              ) : null}

              {hits.modules.length > 0 ? (
                <div className="sidebar-group">
                  <p className="sidebar-group-label">Modules</p>
                  {hits.modules.map(({ meta, hint }) => (
                    <ModuleNavItem
                      key={meta.id}
                      guildId={guildId}
                      moduleId={meta.id}
                      label={meta.label}
                      icon={meta.icon}
                      hint={hint}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ) : null}

              {hits.records.length > 0 ? (
                <div className="sidebar-group">
                  <p className="sidebar-group-label">Records</p>
                  {hits.records.map(({ link }) => (
                    <ModuleLink
                      key={link.id}
                      guildId={guildId}
                      moduleId={link.moduleId}
                      search={{ area: link.area }}
                      className="sidebar-item"
                      onClick={onNavigate}
                    >
                      <Icon name={link.icon} size={16} className="sidebar-item-icon" />
                      <span className="sidebar-item-label">{link.label}</span>
                    </ModuleLink>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="sidebar-group">
                <Link
                  to="/dashboard/$guildId"
                  params={{ guildId }}
                  className="sidebar-item"
                  activeOptions={{ exact: true }}
                  onClick={onNavigate}
                >
                  <Icon name="squares-four" size={16} className="sidebar-item-icon" />
                  <span className="sidebar-item-label">Overview</span>
                </Link>
              </div>

              {NAV_GROUPS.filter((group) => group.id !== 'records').map((group) => (
                <div className="sidebar-group" key={group.id}>
                  <p className="sidebar-group-label">{group.label}</p>
                  {(grouped.get(group.id) ?? []).map((meta) => (
                    <ModuleNavItem
                      key={meta.id}
                      guildId={guildId}
                      moduleId={meta.id}
                      label={meta.label}
                      icon={meta.icon}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              ))}

              <div className="sidebar-group">
                <p className="sidebar-group-label">Records</p>
                {RECORD_LINKS.map((link) => (
                  <ModuleLink
                    key={link.id}
                    guildId={guildId}
                    moduleId={link.moduleId}
                    search={{ area: link.area }}
                    className="sidebar-item"
                    activeOptions={{ exact: true, includeSearch: true }}
                    onClick={onNavigate}
                  >
                    <Icon name={link.icon} size={16} className="sidebar-item-icon" />
                    <span className="sidebar-item-label">{link.label}</span>
                  </ModuleLink>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
