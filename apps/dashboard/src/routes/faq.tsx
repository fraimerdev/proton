import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { SitePage } from '../components/site/chrome.tsx';
import { documentTitle } from '../lib/document-title.ts';

export const Route = createFileRoute('/faq')({
  head: () => ({ meta: [{ title: documentTitle('FAQ') }] }),
  component: Faq,
});

const GROUPS: readonly {
  title: string;
  items: readonly { question: string; answer: string }[];
}[] = [
  {
    title: 'Getting started',
    items: [
      {
        question: 'What permissions does Proton ask for?',
        answer:
          'The invite asks for exactly the union of what the installed modules need, computed from the modules themselves rather than a hardcoded list. If a module needs a permission Proton does not have, its page says which one and where to grant it, instead of failing quietly.',
      },
      {
        question: 'Which privileged intents does it need?',
        answer:
          'Server Members and Message Content. Server Members is how join roles, verification and welcome messages see anybody arriving. Message Content is how automod, the phishing filter and the honeypot read a message to decide whether to act. Presence is not used.',
      },
      {
        question: 'Nothing happened when I switched a module on.',
        answer:
          'Open that module in the dashboard. If Proton cannot run it, a banner at the top of the page names the missing intent or permission and where it is missing. The server overview marks it Cannot run.',
      },
    ],
  },
  {
    title: 'Moderation',
    items: [
      {
        question: 'Does Proton actually perform destructive actions?',
        answer:
          'Yes. Every action is performed for real in every environment. The only preview is the one you ask for: restoring a backup shows you the exact changes and waits for you to confirm.',
      },
      {
        question: 'How do warnings turn into a timeout or a ban?',
        answer:
          'Moderation has a warn escalation ladder. You set the rungs — three warnings becomes a one hour timeout, five becomes a day, and so on — and Proton counts within the window you choose. The ladder only acts while Moderation is switched on.',
      },
      {
        question: 'Can members appeal?',
        answer:
          'Yes. Appeals are forms you build: your own questions, your own eligibility window, delivered to a review channel. A member gets a link rather than having to DM a moderator.',
      },
    ],
  },
  {
    title: 'Data and privacy',
    items: [
      {
        question: 'Does Proton store our messages?',
        answer:
          'Only if you switch it on. Message logging and ticket transcripts are off by default, and anything stored is deleted after 30 days. Reading a message to filter it does not store it.',
      },
      {
        question: 'Who can see what changed in the dashboard?',
        answer:
          'Every dashboard change is written to an audit record with who made it, when, and the before and after values.',
      },
    ],
  },
];

function Faq(): ReactElement {
  return (
    <SitePage>
      <div className="site-section" style={{ paddingTop: 56, paddingBottom: 72 }}>
        <h1 className="site-heading">Questions</h1>
        <p className="site-lede">
          The things administrators ask before and just after adding Proton.
        </p>

        {GROUPS.map((group) => (
          <section className="section" key={group.title}>
            <h2 className="section-label">{group.title}</h2>
            <div className="rows">
              {group.items.map((item) => (
                <div className="row stacked" key={item.question}>
                  <div className="row-main">
                    <h3 className="row-title">{item.question}</h3>
                    <p className="row-description" style={{ maxWidth: '78ch', marginTop: 5 }}>
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
