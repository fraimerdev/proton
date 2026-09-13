import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { type ReactElement, useEffect } from 'react';
import { SignedInProvider } from '../components/site/chrome.tsx';
import { viewerQuery } from '../lib/queries.ts';
import type { RouterContext } from '../router.tsx';
import appCss from '../styles.css?url';

export const Route = createRootRouteWithContext<RouterContext>()({
  // prefetchQuery, not fetchQuery: it swallows a failed check, which would otherwise error every page.
  loader: ({ context }) => context.queryClient.prefetchQuery(viewerQuery()),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'dark' },
      { title: 'Proton' },
    ],
    links: [
      { rel: 'icon', href: '/favicon.ico', sizes: '48x48 32x32 16x16' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      // Inter carries the whole product — 11px section labels through the 29px page title — so the
      // first paint discovering it only after the stylesheet parses reflows every row on the page.
      // One variable woff2 covers 400..700.
      {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: 'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2',
        crossOrigin: 'anonymous',
      },
      // Manrope is named by no CSS rule: @proton/cards rasterises the rank card in Manrope and
      // Inter, and the dashboard's live preview has to match the PNG the bot actually posts.
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=IBM+Plex+Mono:wght@400;500;600&family=Manrope:wght@400;600;700;800&display=swap',
      },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent(): ReactElement {
  const queryClient = useQueryClient();
  const signedIn = useQuery(viewerQuery()).data?.signedIn ?? null;

  // Back after sign-in restores this page from the bfcache with an answer too young to refetch.
  useEffect(() => {
    function restored(event: PageTransitionEvent): void {
      if (event.persisted) void queryClient.invalidateQueries({ queryKey: viewerQuery().queryKey });
    }

    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, [queryClient]);

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <SignedInProvider value={signedIn}>
          <Outlet />
        </SignedInProvider>
        <Scripts />
      </body>
    </html>
  );
}
