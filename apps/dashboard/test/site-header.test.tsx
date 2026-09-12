import { describe, expect, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignedInProvider, SiteHeader } from '../src/components/site/chrome.tsx';

async function header(signedIn: boolean | null): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SignedInProvider value={signedIn}>
          <SiteHeader />
        </SignedInProvider>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  await router.load();

  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('the site header', () => {
  test('offers a signed-out visitor Discord sign-in instead of the dashboard', async () => {
    const html = await header(false);

    expect(html).toContain('Login with Discord');
    expect(html).toContain('href="/api/auth/signin/discord"');
    expect(html).not.toContain('>Dashboard<');
  });

  test('takes a signed-in admin straight to the dashboard', async () => {
    const html = await header(true);

    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('>Dashboard<');
    expect(html).not.toContain('Login with Discord');
  });

  test('falls back to the dashboard while the answer is unknown, because that route asks for sign-in', async () => {
    const html = await header(null);

    expect(html).toContain('>Dashboard<');
    expect(html).not.toContain('Login with Discord');
  });
});
