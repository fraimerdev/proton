import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import { type ReactElement, useEffect } from 'react';
import { ProtonMark } from '../components/shell/topbar.tsx';
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
      // Inter carries the whole product — 11px section labels through the 29px page title — so the
      // first paint discovering it only after the stylesheet parses reflows every row on the page.
      // One variable woff2 covers every weight.
      {
        rel: 'preload',
        as: 'font',
        type: 'font/woff2',
        href: interLatin,
        crossOrigin: 'anonymous',
      },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFound,
});

function NotFound(): ReactElement {
  return (
    <main className="centred">
      <section className="centred-card">
        <ProtonMark size={34} />

        <h1 style={{ marginTop: 16 }}>Page not found</h1>
        <p>There’s no page at this address.</p>

        <Link
          to="/"
          className="button button-primary button-lg button-block"
          style={{ marginTop: 20 }}
        >
          Back to the site
        </Link>
      </section>
    </main>
  );
}

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
