import { createFileRoute, Link } from '@tanstack/react-router';
import { type ReactElement, useEffect, useState } from 'react';
import { MODULE_GROUPS } from '../components/site/catalogue.ts';
import { SitePage, useSignedIn } from '../components/site/chrome.tsx';
import { COMMAND_SET } from '../components/site/command-set.gen.ts';
import { Icon } from '../components/ui/icon.tsx';
import { MODULE_BY_ID, MODULES } from '../lib/modules/catalogue.ts';

export const Route = createFileRoute('/')({
  component: Landing,
});

let heroEntered = false;

function Landing(): ReactElement {
  const signedIn = useSignedIn();
  // State, not the flag: re-reading it on a later render would cut the entrance off mid-flight.
  const [enter] = useState(() => !heroEntered);

  useEffect(() => {
    heroEntered = true;
  }, []);

  return (
    <SitePage>
      <section
        className={enter ? 'site-section site-hero site-hero-enter' : 'site-section site-hero'}
      >
        <h1>One bot that does the whole job, and says so when it can’t.</h1>
        <p>
          Proton is {MODULES.length} modules of moderation, security and community tooling for
          Discord, with a dashboard built for administering a server rather than for a screenshot.
          When something is missing a permission or an intent, it tells you which one and where.
        </p>

        <div className="site-hero-actions">
          <Link
            to={signedIn === true ? '/dashboard' : '/signin'}
            className="button button-primary button-lg"
          >
            <Icon name="discord-logo" size={17} weight="fill" />
            {signedIn === true ? 'Open the dashboard' : 'Log in with Discord'}
          </Link>
          <Link to="/commands" className="button button-secondary button-lg">
            Browse {COMMAND_SET.length} commands
          </Link>
        </div>
      </section>

      {MODULE_GROUPS.map((group) => (
        <section className="site-block" key={group.title}>
          <div className="site-section">
            <h2 className="site-heading">{group.title}</h2>
            <p className="site-lede">{group.blurb}</p>

            <div className="site-grid">
              {group.modules.map((moduleId) => {
                const meta = MODULE_BY_ID.get(moduleId);
                if (!meta) return null;

                return (
                  <div className="site-grid-item" key={moduleId}>
                    <h3>
                      <Icon name={meta.icon} size={17} />
                      {meta.label}
                    </h3>
                    <p>{meta.aliases.slice(0, 4).join(' · ')}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ))}

      <section className="site-block">
        <div className="site-section">
          <h2 className="site-heading">Nothing is on until you switch it on</h2>
          <p className="site-lede">
            Proton joins a server doing nothing. Every module starts off, message logging and ticket
            transcripts are off by default, and anything stored is deleted after 30 days.
          </p>
          <div className="site-hero-actions">
            <Link to="/privacy" className="button button-secondary">
              What Proton stores
            </Link>
            <Link to="/faq" className="button button-ghost">
              Common questions
            </Link>
          </div>
        </div>
      </section>
    </SitePage>
  );
}
