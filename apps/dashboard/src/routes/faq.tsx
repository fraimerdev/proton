import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Icon } from '../components/shell/icon.tsx';
import { SitePage } from '../components/site/chrome.tsx';
import { FAQ, QuestionList } from '../components/site/faq.tsx';
import { documentTitle } from '../lib/document-title.ts';
import { SUPPORT_INVITE } from '../lib/site-meta.ts';

export const Route = createFileRoute('/faq')({
  head: () => ({
    meta: [
      { title: documentTitle('Questions') },
      {
        name: 'description',
        content:
          'What Proton stores, which permissions it asks Discord for, what happens when it cannot run, and who on your staff can configure it.',
      },
    ],
  }),
  component: FaqPage,
});

function FaqPage(): ReactElement {
  return (
    <SitePage>
      <div className="doc-page doc-page-wide">
        <header className="doc-head">
          <span className="site-label">Questions</span>
          <h1 className="doc-title">What Proton does, and what it will not do.</h1>
          <p className="doc-lede">
            Answers to the things worth knowing before you add a bot to a server other people are in
            — what it reads, what it writes down, and what happens when Discord will not let it act.
          </p>
        </header>

        <div className="doc-split">
          <nav className="doc-nav" aria-label="Sections">
            <span className="site-label">On this page</span>
            <ul>
              {FAQ.map((group) => (
                <li key={group.id}>
                  <a href={`#${group.id}`}>{group.label}</a>
                </li>
              ))}
            </ul>

            <div className="doc-nav-foot">
              <Link to="/privacy">Privacy policy</Link>
              <Link to="/terms">Terms of Service</Link>
              <a href={SUPPORT_INVITE} rel="noreferrer noopener" target="_blank">
                Support server
              </a>
            </div>
          </nav>

          <div className="doc-body">
            {FAQ.map((group) => (
              <section className="faq-group" id={group.id} key={group.id}>
                <h2 className="faq-group-title">{group.label}</h2>
                <QuestionList questions={group.questions} />
              </section>
            ))}

            <div className="doc-tail">
              <p>
                Nothing here answers it? Ask in the support server. The{' '}
                <Link to="/privacy">privacy policy</Link> is the complete list of what Proton
                stores, and the <Link to="/terms">Terms of Service</Link> cover what you are
                agreeing to when you add it.
              </p>
              <div className="doc-tail-actions">
                <a
                  className="button button-quiet"
                  href={SUPPORT_INVITE}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  Support server
                </a>
                <a className="button button-discord" href="/invite">
                  <Icon name="discord-logo" weight="fill" />
                  Add to Discord
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SitePage>
  );
}
