import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Icon } from '../../components/shell/icon.tsx';
import { sessionQuery } from '../../lib/queries.ts';
import { completeWebVerification, type VerificationOutcome } from '../../server/verification.ts';

type VerifyState = VerificationOutcome | { ok: false; signIn: string };

export const Route = createFileRoute('/verify/$token')({
  head: () => ({ meta: [{ title: 'Proton — Verify' }] }),

  loader: async ({ params, context }): Promise<VerifyState> => {
    const session = await context.queryClient.fetchQuery(sessionQuery()).catch(() => null);

    // Not a redirect: bouncing straight to Discord would mean a link opened by a signed-out member
    // leaves the site before they have been told what they are agreeing to.
    if (!session?.user) {
      return {
        ok: false,
        signIn: `/api/auth/signin/discord?redirect=${encodeURIComponent(`/verify/${params.token}`)}`,
      };
    }

    return completeWebVerification({ data: { token: params.token } });
  },

  component: VerifyPage,
});

function VerifyPage(): ReactElement {
  const state = Route.useLoaderData();

  return (
    <div className="plain-page">
      <div className="page verify-page">
        <Link to="/" className="back-link">
          <Icon name="arrow-left" />
          Proton
        </Link>

        {state.ok ? (
          <Passed />
        ) : 'signIn' in state ? (
          <SignIn href={state.signIn} />
        ) : (
          <Refused reason={state.reason} />
        )}
      </div>
    </div>
  );
}

function SignIn({ href }: { href: string }): ReactElement {
  return (
    <section className="verify-card">
      <h1>Verify your account</h1>
      <p>
        Sign in with Discord so Proton can confirm this link belongs to you. Proton reads your
        account name and the servers you are in, and nothing else.
      </p>
      <a className="button button-discord" href={href}>
        <Icon name="discord-logo" weight="fill" />
        Continue with Discord
      </a>
    </section>
  );
}

function Passed(): ReactElement {
  return (
    <section className="verify-card">
      <h1>You&rsquo;re verified</h1>
      <p>
        Your access is being applied now — head back to Discord and it should be there within a few
        seconds. You can close this page.
      </p>
    </section>
  );
}

function Refused({ reason }: { reason: string }): ReactElement {
  return (
    <section className="verify-card">
      <h1>That didn&rsquo;t work</h1>
      <p>{reason}</p>
    </section>
  );
}
