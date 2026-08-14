import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/**
 * Must be named `getRouter` — TanStack Start's client entry imports exactly this
 * symbol from the configured router file. Exporting it as `createRouter` builds
 * 292 modules and then fails at the very end with MISSING_EXPORT.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
