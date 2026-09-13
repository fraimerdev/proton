import type { ModuleSummary } from '@proton/core';
import { useChildMatches, useRouterState } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { SessionGuild } from '../../lib/guild-access.ts';
import { cx } from '../ui/controls.tsx';
import { usePresence } from '../ui/overlay.tsx';
import { Sidebar } from './sidebar.tsx';
import { Topbar, type Viewer } from './topbar.tsx';

export function DashboardShell({
  guildId,
  guilds,
  presenceKnown,
  viewer,
  modules,
  onSignOut,
  children,
}: {
  guildId: string;
  guilds: readonly SessionGuild[];
  presenceKnown: boolean;
  viewer: Viewer;
  modules: readonly ModuleSummary[];
  onSignOut: () => void;
  children: ReactNode;
}): ReactElement {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.href });
  const scrim = useRef<HTMLButtonElement>(null);
  const scrimPresence = usePresence(navOpen, scrim);

  // The presented match, not location: location moves on click and would remount the outgoing page.
  const view = useChildMatches({ select: (matches) => matches[0]?.pathname ?? '' });
  const [firstView] = useState(view);
  const [navigated, setNavigated] = useState(false);
  if (!navigated && view !== firstView) setNavigated(true);

  // The drawer is a navigation surface: arriving somewhere is what closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation is the trigger, not an input
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className="shell">
      <Topbar
        guilds={guilds}
        guildId={guildId}
        presenceKnown={presenceKnown}
        viewer={viewer}
        onSignOut={onSignOut}
        onToggleNav={() => setNavOpen((open) => !open)}
        navOpen={navOpen}
      />

      <div className="shell-container shell-body">
        <Sidebar guildId={guildId} modules={modules} open={navOpen} />

        {scrimPresence.present ? (
          <button
            ref={scrim}
            type="button"
            className={cx('sidebar-scrim', scrimPresence.leaving && 'leaving')}
            aria-label="Close navigation"
            inert={scrimPresence.leaving}
            onClick={() => setNavOpen(false)}
            onAnimationEnd={scrimPresence.onAnimationEnd}
          />
        ) : null}

        <main className="workspace">
          <div key={view} className={navigated ? 'motion-enter' : undefined}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export function Workspace({ children }: { children: ReactNode }): ReactElement {
  return <div className="page">{children}</div>;
}
