import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProtonMark } from '../../components/shell/topbar.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { documentTitle } from '../../lib/document-title.ts';
import { sessionQuery } from '../../lib/queries.ts';
import { completeWebVerification, type VerificationOutcome } from '../../server/verification.ts';

type VerifyState = VerificationOutcome | { ok: false; signIn: string };

export const Route = createFileRoute('/verify/$token')({
  head: () => ({ meta: [{ title: documentTitle('Verify') }] }),

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

export function LinkCard({
  title,
  children,
  action,
  tone = 'neutral',
  entering = false,
}: {
  title: string;
  children: ReactElement | string;
  action?: ReactElement | undefined;
  tone?: 'neutral' | 'success' | 'danger' | undefined;
  entering?: boolean | undefined;
}): ReactElement {
  return (
    <main className="centred">
      <section className={entering ? 'centred-card motion-enter' : 'centred-card'}>
        <Link to="/" className="topbar-brand" style={{ marginBottom: 18 }}>
          <ProtonMark size={22} />
          Proton
        </Link>

        <h1>
          {tone === 'success' ? (
            <Icon name="check-circle" size={22} weight="fill" className="text-success motion-pop" />
          ) : tone === 'danger' ? (
            <Icon name="warning-circle" size={22} weight="fill" className="text-danger" />
          ) : null}{' '}
          {title}
        </h1>
        <p>{children}</p>
        {action !== undefined ? <div style={{ marginTop: 20 }}>{action}</div> : null}
      </section>
    </main>
  );
}

function VerifyPage(): ReactElement {
  const state = Route.useLoaderData();

  if (!state.ok && 'signIn' in state) {
    return (
      <LinkCard
        title="Verify your account"
        action={
          <a className="button button-primary button-block" href={state.signIn}>
            <Icon name="discord-logo" size={16} weight="fill" />
            Continue with Discord
          </a>
        }
      >
        Sign in with Discord so Proton can confirm this link belongs to you. Proton reads your
        account name and the servers you are in, and nothing else.
      </LinkCard>
    );
  }

  if (!state.ok) {
    return (
      <LinkCard title="That did not work" tone="danger">
        {state.reason}
      </LinkCard>
    );
  }

  return (
    <LinkCard title="You are verified" tone="success">
      Your access is being applied and should appear in Discord within a few seconds. You can close
      this page.
    </LinkCard>
  );
}
