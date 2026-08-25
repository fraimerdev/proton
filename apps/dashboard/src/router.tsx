import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import type { ReactElement } from 'react';
import { Icon } from './components/shell/icon.tsx';
import { makeQueryClient } from './lib/query-client.ts';
import { routeTree } from './routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
}

// A module page waits on four fetches, and until one of them answered the previous page simply
// stayed on screen. The empty-state shape is the one the product already uses for "nothing here
// yet", which is what a page that has not arrived looks like.
function RoutePending(): ReactElement {
  return (
    <div className="card">
      <div className="empty-state">
        <span className="tile">
          <Icon name="hourglass-medium" />
        </span>
        <span className="empty-state-title">Loading.</span>
        <p className="status">Proton is fetching this page from Discord and its own API.</p>
      </div>
    </div>
  );
}

export function getRouter() {
  const queryClient = makeQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',

    // 0, not the 30s default: the loaders call fetchQuery, which already answers from the cache
    // while it is fresh, so a second staleness clock in the router would only mask the first.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultPendingComponent: RoutePending,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
