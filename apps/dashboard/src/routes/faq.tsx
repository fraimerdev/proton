import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { SitePage } from '../components/site/chrome.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/faq')({
  head: () => ({ meta: [{ title: documentTitle('FAQ') }] }),
  component: Faq,
});

const GROUPS: readonly {
  title: string;
  items: readonly { question: string; answer: ReactNode }[];
}[] = [
  {
    title: 'Getting started',
    items: [
      {
        question: 'What permissions does Proton ask for?',
        answer:
          'The permissions its modules need between them, and nothing more. If a module can’t run because Proton is missing a permission, the module’s page says which one and where to grant it.',
      },
      {
        question: 'Which privileged intents does it need?',
        answer:
          'Server Members and Message Content. Server Members lets modules like Join Roles, Verification and Welcomer see members arrive, and Message Content lets Automod and Phishing read a message to decide whether to act. Presence isn’t used.',
      },
      {
        question: 'Nothing happened when I turned a module on.',
        answer:
          'Open the module in the dashboard. If Proton can’t run it, a banner at the top of the page names the missing permission or intent and where it’s missing, and the server overview marks it Can’t run.',
      },
    ],
  },
  {
    title: 'Moderation',
    items: [
      {
        question: 'Does Proton actually perform destructive actions?',
        answer:
          'Yes. Bans, kicks, timeouts, and channel and role changes all happen for real. The only preview is when you restore a backup: Proton shows the exact changes and waits for you to confirm.',
      },
      {
        question: 'How do warnings turn into a timeout or a ban?',
        answer:
          'Through Moderation’s warn escalation. You choose how many warnings lead to a timeout, kick or ban and how far back they count, for example a 1 hour timeout at 3 warnings and a 1 day timeout at 5. It only acts while Moderation is on.',
      },
      {
        question: 'Can members appeal?',
        answer:
          'Members banned by Honeypot can. Its ban DM can link to an appeal form you build, and appeals arrive in a review channel where staff accept or turn them down.',
      },
      {
        question: 'How do I set up user reports?',
        answer:
          'In the dashboard, open Moderation → User reports and choose Set up user reports. Five steps cover how members report, where reports go, reasons and evidence, and who can report and review. Nothing is turned on until the last step.',
      },
      {
        question: 'Which permissions do user reports and punish settings need?',
        answer:
          'View Channel, Send Messages and Embed Links in the report channel, and Timeout Members, Kick Members or Ban Members for the punishments you use. Some options need more, such as Manage Messages to remove report reactions or to delete a reported message.',
      },
    ],
  },
  {
    title: 'Data and privacy',
    items: [
      {
        question: 'Does Proton store our messages?',
        answer: (
          <>
            Only for features you turn on, such as message logs and ticket message capture, which
            keep message text for 30 days. Incoming events, message text included, clear out of
            Proton’s queue within about a day, or about a week if they fail to process. The{' '}
            <Link to="/privacy">privacy policy</Link> lists what each feature keeps and for how
            long.
          </>
        ),
      },
      {
        question: 'Who can see what changed in the dashboard?',
        answer:
          'Every change is recorded, but the record isn’t shown in the dashboard. Turn on Server Logs to post settings changes, and modules being turned on or off, to a channel you choose, with who made each one.',
      },
    ],
  },
];

function Faq(): ReactElement {
  return (
    <SitePage>
      <div className="site-section" style={{ paddingTop: 56, paddingBottom: 72 }}>
        <h1 className="site-heading">Frequently asked questions</h1>

        {GROUPS.map((group) => (
          <section className="section" key={group.title}>
            <h2 className="section-label">{group.title}</h2>
            <div className="rows">
              {group.items.map((item) => (
                <div className="row stacked" key={item.question}>
                  <div className="row-main">
                    <h3 className="row-title">{item.question}</h3>
                    <p
                      className="row-description faq-answer"
                      style={{ maxWidth: '78ch', marginTop: 5 }}
                    >
                      {item.answer}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SitePage>
  );
}
