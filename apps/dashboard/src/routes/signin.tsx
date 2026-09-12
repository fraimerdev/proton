import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { Icon } from '../components/shell/icon.tsx';
import { ProtonMark } from '../components/shell/mark.tsx';
import { OAUTH_SCOPES } from '../components/site/catalogue.ts';
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
    <main className="plain-page">
      <section className="signin-card">
        <span className="signin-mark">
          <ProtonMark size={52} />
        </span>

        <h1>Sign in to the dashboard</h1>
        <p className="signin-lede">
          Proton asks Discord who you are and which servers you manage, so it can list the ones you
          can configure. It asks for nothing else — the exact scopes are at the foot of this card.
        </p>

        {error ? (
          <div className="alert-banner signin-alert" role="alert">
            <Icon name="warning-circle" weight="fill" />
            <span className="alert-banner-text">
              Discord did not finish signing you in, so nothing was shared
              {description ? `: ${description.replace(/\.$/, '')}` : ''}. Try again below; if it
              keeps failing, check which Discord account this browser is signed in to.
            </span>
          </div>
        ) : null}

        <a className="button button-discord signin-cta" href={href}>
          <Icon name="discord-logo" weight="fill" />
          Continue with Discord
        </a>
        <Link to="/" className="button button-quiet signin-back">
          Back to the site
        </Link>

        <p className="signin-scopes">
          <span className="sr-only">Scopes requested: </span>
          {OAUTH_SCOPES.join(' · ')}
        </p>
      </section>
    </main>
  );
}
