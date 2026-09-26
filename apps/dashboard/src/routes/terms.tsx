import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProsePage } from '../components/site/prose.tsx';
import { documentTitle } from '../lib/document-title.ts';
import { SUPPORT_INVITE } from '../lib/site-meta.ts';

export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: documentTitle('Terms') }] }),
  component: Terms,
});

function Terms(): ReactElement {
  return (
    <ProsePage
      title="Terms"
      updated="2026-09-22"
      related={{ to: '/privacy', label: 'Privacy policy' }}
      sections={[
        {
          id: 'agreement',
          heading: 'Agreeing to these terms',
          body: (
            <p>
              By adding Proton to a server, using its commands or signing in at prtn.xyz, you accept
              these terms. The <Link to="/privacy">privacy policy</Link> explains what Proton keeps
              and why.
            </p>
          ),
        },
        {
          id: 'who-may-use-proton',
          heading: 'Who may use Proton',
          body: (
            <p>
              You must meet Discord’s minimum age for your country and follow Discord’s Terms of
              Service and Community Guidelines. Discord lets only members with the Manage Server
              permission add Proton to a server.
            </p>
          ),
        },
        {
          id: 'your-responsibilities',
          heading: 'What you are responsible for',
          body: (
            <ul>
              <li>
                The configuration you save. Proton performs what you configure (bans, kicks,
                timeouts, channel and role changes) for real, as soon as it is triggered.
              </li>
              <li>
                Telling your members what you have switched on, especially features that keep what
                they write or track what they do: message logs, ticket message capture, appeals,
                suggestions, starboard and leveling.
              </li>
              <li>
                Giving Proton the permissions its modules need. Proton skips any step it lacks the
                permission for, and a module’s page names any permission it needs to run at all.
              </li>
            </ul>
          ),
        },
        {
          id: 'acceptable-use',
          heading: 'Acceptable use',
          body: (
            <ul>
              <li>
                Don’t use Proton to harass anyone, to get around Discord’s rules, or to collect data
                about members beyond running your server.
              </li>
              <li>
                Don’t try to disrupt the service or its rate limits, or to reach servers other than
                your own through it.
              </li>
            </ul>
          ),
        },
        {
          id: 'limits',
          heading: 'Limits',
          body: (
            <p>
              Some features have limits, such as how many tags or running giveaways a server can
              have, or how many reminders one member can set. The dashboard shows the limits on what
              you set up there, and a command that reaches a limit says which one.
            </p>
          ),
        },
        {
          id: 'no-warranty',
          heading: 'What Proton does not promise',
          body: (
            <>
              <p>
                Proton is provided as is, without warranty. It depends on Discord’s API and on
                network conditions outside its control, so it cannot guarantee uninterrupted service
                or that any individual action reaches Discord.
              </p>
              <p>Automated moderation is a filter, not a judgement. Review the cases it opens.</p>
            </>
          ),
        },
        {
          id: 'ending-it',
          heading: 'Ending it',
          body: (
            <p>
              You can remove Proton from a server at any time, and it then stops receiving that
              server’s events. What it had kept is handled as the privacy policy describes. Proton’s
              operator may stop providing Proton to a server that breaks these terms or Discord’s.
            </p>
          ),
        },
        {
          id: 'contact',
          heading: 'Questions',
          body: (
            <p>
              Ask about these terms in{' '}
              <a href={SUPPORT_INVITE} target="_blank" rel="noreferrer">
                Proton’s support server
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
              .
            </p>
          ),
        },
        {
          id: 'changes',
          heading: 'Changes',
          body: (
            <p>
              These terms may change as Proton changes, and the date at the top says when they last
              did.
            </p>
          ),
        },
      ]}
    />
  );
}
