import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import type { ReactElement } from 'react';
import { makeQueryClient } from './lib/query-client.ts';
import { routeTree } from './routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
}

// A module page waits on four fetches, and until one of them answered the previous page simply
// stayed on screen. role=status with the word offscreen, because the ring itself says nothing to a
// screen reader and a page that is still arriving has to announce that it is.
function RoutePending(): ReactElement {
  return (
    <div className="route-pending" role="status">
      <span className="spinner" />
      <span className="sr-only">Loading</span>
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
