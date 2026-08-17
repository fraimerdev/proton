import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { currentUser } from '../server/session.ts';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Proton' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  loader: () => currentUser(),
  component: RootComponent,
});

function RootComponent(): ReactElement {
  const user = Route.useLoaderData();

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header className="app-header">
          <strong>Proton</strong>
          {user ? (
            <form className="session" method="post" action="/api/auth/signout">
              <span className="field-description">{user.name}</span>
              <button className="button button-quiet" type="submit">
                Sign out
              </button>
            </form>
          ) : null}
        </header>
        <main className="app-main">
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  );
}
