import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { Spinner } from './components/shell/pending.tsx';
import { makeQueryClient } from './lib/query-client.ts';
import { routeTree } from './routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
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
    // Routes that know nothing about the page they are fetching. The module route replaces this
    // with one that keeps its own header on screen.
    defaultPendingComponent: Spinner,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
