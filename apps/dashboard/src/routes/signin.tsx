import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { ProtonMark } from '../components/shell/topbar.tsx';
import { OAUTH_SCOPES } from '../components/site/catalogue.ts';
import { StatusBanner } from '../components/ui/feedback.tsx';
import { Icon } from '../components/ui/icon.tsx';
import { DEFAULT_CALLBACK } from '../lib/callback-url.ts';
import { documentTitle } from '../lib/document-title.ts';

const signInSearchSchema = z.object({
  redirect: z
    .string()
    .regex(/^\/[^/\\]/)
    .optional()
    .catch(undefined),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export const Route = createFileRoute('/signin')({
  validateSearch: zodValidator(signInSearchSchema),
  head: () => ({ meta: [{ title: documentTitle('Sign in') }] }),
  component: SignIn,
});

function SignIn(): ReactElement {
  const { redirect, error, error_description: description } = Route.useSearch();
  const href = `/api/auth/signin/discord?redirect=${encodeURIComponent(redirect ?? DEFAULT_CALLBACK)}`;

  return (
    <main className="centred">
      <section className="centred-card">
        <ProtonMark size={34} />

        <h1 style={{ marginTop: 16 }}>Sign in</h1>
        <p>
          Proton asks Discord who you are and which servers you manage, and nothing else. The exact
          scopes are listed below.
        </p>

        {error ? (
          <div style={{ marginTop: 16 }}>
            <StatusBanner tone="danger" live="assertive">
              Discord did not finish signing you in, so nothing was shared
              {description ? `: ${description.replace(/\.$/, '')}` : ''}. Try again. If it keeps
              failing, check which Discord account this browser is signed in to.
            </StatusBanner>
          </div>
        ) : null}

        <a
          className="button button-primary button-lg button-block"
          href={href}
          style={{ marginTop: 20 }}
        >
          <Icon name="discord-logo" size={17} weight="fill" />
          Continue with Discord
        </a>

        <Link to="/" className="button button-ghost button-block" style={{ marginTop: 8 }}>
          Back to the site
        </Link>

        <p className="text-xs text-muted" style={{ marginTop: 20, textAlign: 'center' }}>
          <span className="visually-hidden">Scopes requested: </span>
          <span className="mono">{OAUTH_SCOPES.join(' · ')}</span>
        </p>
      </section>
    </main>
  );
}
