import type { ModuleSummary } from '@proton/core';
import { createLink, Link, useRouterState } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ComponentProps, ReactElement, ReactNode, Ref } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  areaMeta,
  MODULE_BY_ID,
  MODULES,
  NAV_GROUPS,
  type NavGroupId,
  RECORD_LINKS,
} from '../../lib/modules/catalogue.ts';
import { searchModules } from '../../lib/modules/search.ts';
import { useModuleSearch } from '../module/route.tsx';
import { cx, SearchField } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';

// Not ModuleLink: Link marks itself current from its own match, which cannot see a default area.
const SidebarAnchor = createLink(function SidebarAnchor({
  current,
  children,
  className: _className,
  'aria-current': _ariaCurrent,
  'data-status': _status,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  current: boolean;
  'data-status'?: string | undefined;
  ref?: Ref<HTMLAnchorElement> | undefined;
}): ReactElement {
  return (
    <a
      {...rest}
      className={cx('sidebar-item', current && 'active')}
      aria-current={current ? 'page' : undefined}
    >
      {children}
    </a>
  );
});

function SidebarLink({
  guildId,
  moduleId,
  area,
  current,
  children,
}: {
  guildId: string;
  moduleId: string;
  area?: string | undefined;
  current: boolean;
  children: ReactNode;
}): ReactElement {
  const props = {
    to: `/dashboard/$guildId/${moduleId}`,
    params: { guildId },
    search: { area },
    current,
    children,
  } as unknown as ComponentProps<typeof SidebarAnchor>;

  return <SidebarAnchor {...props} />;
}

function ModuleNavItem({
  guildId,
  moduleId,
  label,
  icon,
  hint,
  area,
  current,
}: {
  guildId: string;
  moduleId: string;
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  hint?: string | undefined;
  area?: string | undefined;
  current: boolean;
}): ReactElement {
  return (
    <SidebarLink guildId={guildId} moduleId={moduleId} area={area} current={current}>
      <Icon name={icon} size={16} className="sidebar-item-icon" />
      <span className="sidebar-item-label">
        {label}
        {hint !== undefined ? <span className="text-muted text-xs"> · {hint}</span> : null}
      </span>
    </SidebarLink>
  );
}

export function Sidebar({
  guildId,
  modules,
  open,
  inert = false,
}: {
  guildId: string;
  modules: readonly ModuleSummary[];
  open: boolean;
  inert?: boolean | undefined;
}): ReactElement {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { area } = useModuleSearch();

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

  useEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
  }, [open]);

  const grouped = useMemo(() => {
    const map = new Map<NavGroupId, typeof MODULES>();
    for (const group of NAV_GROUPS) map.set(group.id, []);

    for (const meta of MODULES) {
      if (meta.switchOnly) continue;
      const list = map.get(meta.group);
      if (list) map.set(meta.group, [...list, meta]);
    }

    return map;
  }, []);

  const currentRecord = RECORD_LINKS.find((link) => {
    const meta = MODULE_BY_ID.get(link.moduleId);
    return (
      meta !== undefined &&
      pathname.endsWith(`/${link.moduleId}`) &&
      areaMeta(meta, area)?.id === link.area
    );
  })?.id;

  const isCurrentModule = (moduleId: string): boolean => {
    if (currentRecord !== undefined) return false;
    const base = `/dashboard/${guildId}/${moduleId}`;
    return pathname === base || pathname.startsWith(`${base}/`);
  };

  return (
    <nav className={cx('sidebar', open && 'open')} aria-label="Modules" inert={inert}>
      <div className="sidebar-inner">
        <div className="sidebar-search">
          <SearchField
            ref={search}
            value={query}
            onChange={setQuery}
            placeholder="Search settings…"
            label="Search modules and settings"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || query === '') return;
              event.preventDefault();
              setQuery('');
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
                  {hits.modules.map((hit) => (
                    <ModuleNavItem
                      key={hit.meta.id}
                      guildId={guildId}
                      moduleId={hit.meta.id}
                      label={hit.meta.label}
                      icon={hit.meta.icon}
                      hint={hit.hint}
                      area={hit.area}
                      current={isCurrentModule(hit.meta.id)}
                    />
                  ))}
                </div>
              ) : null}

              {hits.records.length > 0 ? (
                <div className="sidebar-group">
                  <p className="sidebar-group-label">Records</p>
                  {hits.records.map(({ link }) => (
                    <SidebarLink
                      key={link.id}
                      guildId={guildId}
                      moduleId={link.moduleId}
                      area={link.area}
                      current={currentRecord === link.id}
                    >
                      <Icon name={link.icon} size={16} className="sidebar-item-icon" />
                      <span className="sidebar-item-label">{link.label}</span>
                    </SidebarLink>
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
                      current={isCurrentModule(meta.id)}
                    />
                  ))}
                </div>
              ))}

              <div className="sidebar-group">
                <p className="sidebar-group-label">Records</p>
                {RECORD_LINKS.map((link) => (
                  <SidebarLink
                    key={link.id}
                    guildId={guildId}
                    moduleId={link.moduleId}
                    area={link.area}
                    current={currentRecord === link.id}
                  >
                    <Icon name={link.icon} size={16} className="sidebar-item-icon" />
                    <span className="sidebar-item-label">{link.label}</span>
                  </SidebarLink>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
