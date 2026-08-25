import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { Icon } from '../components/shell/icon.tsx';
import type { IconName } from '../components/shell/icon-set.gen.ts';
import {
  COMMAND_COUNT,
  LOG_EVENT_COUNT,
  MODULE_COUNT,
  OAUTH_SCOPES,
  TOP_LEVEL_COMMANDS,
} from '../components/site/catalogue.ts';
import { SitePage } from '../components/site/chrome.tsx';
import { featured, QuestionList } from '../components/site/faq.tsx';
import { SHOTS, ShotFrame } from '../components/site/shot.tsx';
import { SITE_DESCRIPTION } from '../lib/site-meta.ts';

// Better Auth redirects a failed OAuth callback back here with these two, and until it had a route
// to land on the whole failure was a not-found page.
const doorSearchSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  notice: z.literal('invite-unavailable').optional(),
});

const SIGN_IN_FAILURES: Record<string, string> = {
  access_denied: 'Discord did not grant Proton access, so nothing was shared.',
  no_code: 'Discord did not complete the sign-in.',
  invalid_code: 'Discord did not complete the sign-in.',
  unable_to_get_user_info: 'Discord accepted the sign-in but would not return your account.',
  no_callback_url: 'Proton could not work out where to send you back to.',
};

export function signInFailure(code: string, description?: string): string {
  return SIGN_IN_FAILURES[code] ?? description ?? `Discord returned “${code}”.`;
}

export const INVITE_UNAVAILABLE =
  'Proton could not work out which permissions to ask Discord for, so the invite was not started. Its API is not answering.';

export const Route = createFileRoute('/')({
  validateSearch: zodValidator(doorSearchSchema),
  head: () => ({
    meta: [
      { title: 'Proton — the all-in-one Discord bot' },
      { name: 'description', content: SITE_DESCRIPTION },
    ],
  }),
  component: Home,
});

function Home(): ReactElement {
  const { error, error_description: description, notice } = Route.useSearch();

  return (
    <SitePage>
      <section className="hero">
        <img
          className="hero-mark"
          src="/proton-mark.png"
          alt=""
          width={88}
          height={88}
          decoding="async"
        />

        <h1 className="hero-title">
          The all-in-one Discord bot <span>that writes everything down</span>
        </h1>

        <p className="hero-sub">
          {MODULE_COUNT} modules — moderation, anti-raid, tickets, levels, logs — each with its own
          switch. Every action lands in a numbered case with the moderator, the reason and the time.
        </p>

        {error ? (
          <div className="alert-banner hero-alert" role="alert">
            <Icon name="warning-circle" weight="fill" />
            <span className="alert-banner-text">
              {signInFailure(error, description)} You are not signed in.
            </span>
          </div>
        ) : null}

        {notice ? (
          <div className="alert-banner hero-alert" role="alert">
            <Icon name="warning-circle" weight="fill" />
            <span className="alert-banner-text">{INVITE_UNAVAILABLE}</span>
          </div>
        ) : null}

        <div className="hero-actions">
          <a className="button button-discord button-xl" href="/invite">
            <Icon name="discord-logo" weight="fill" />
            Add to Discord
          </a>
          <Link to="/dashboard" className="button button-quiet button-xl">
            Open dashboard
          </Link>
        </div>

        <p className="hero-fine">Needs Manage Server in the server you are adding it to.</p>
      </section>

      <Capabilities />

      <Showcases />

      <CommandStrip />

      <section className="lp" id="questions">
        <header className="lp-head">
          <h2 className="lp-title">Before you add it</h2>
          <p className="lp-lede">
            What it reads, what it writes down, and what happens when Discord will not let it act.
          </p>
        </header>

        <QuestionList questions={featured()} />

        <div className="lp-more">
          <Link to="/faq" className="button button-quiet">
            All questions
            <Icon name="arrow-right" />
          </Link>
        </div>
      </section>

      <section className="closer">
        <h2 className="closer-title">Set it up once. Read it back forever.</h2>
        <p className="closer-sub">
          One Discord consent screen, then {MODULE_COUNT} modules waiting behind their own switches.
        </p>
        <a className="button button-discord button-xl" href="/invite">
          <Icon name="discord-logo" weight="fill" />
          Add to Discord
        </a>
      </section>
    </SitePage>
  );
}

interface Capability {
  icon: IconName;
  title: string;
  body: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    icon: 'gavel',
    title: 'Moderation cases',
    body: 'Every ban, kick and timeout becomes a numbered case you can search and reverse.',
  },
  {
    icon: 'shield-warning',
    title: 'AutoMod filters',
    body: 'Spam, banned words, links and shouting, checked on every message that lands.',
  },
  {
    icon: 'lightning-slash',
    title: 'Anti-nuke and anti-raid',
    body: 'Trips a breaker on mass deletions, and gates a join wave before it lands.',
  },
  {
    icon: 'fish',
    title: 'Phishing and honeypots',
    body: 'Known bad links blocked on sight, and channels that catch bots outright.',
  },
  {
    icon: 'ticket',
    title: 'Tickets',
    body: 'Private support channels with intake forms, timers, staff and transcripts.',
  },
  {
    icon: 'trend-up',
    title: 'Leveling and XP',
    body: 'XP for talking and for voice, role rewards, and a drawn /rank card.',
  },
  {
    icon: 'list-magnifying-glass',
    title: 'Server logs',
    body: `${LOG_EVENT_COUNT} Discord events routed to whichever channels you pick.`,
  },
  {
    icon: 'list-checks',
    title: 'Role menus',
    body: 'Members click a button or a dropdown and give themselves roles.',
  },
  {
    icon: 'gift',
    title: 'Giveaways and polls',
    body: 'Button-entry giveaways, drawn, rerolled and announced by Proton.',
  },
];

function Capabilities(): ReactElement {
  return (
    <section className="lp" id="features">
      <header className="lp-head">
        <h2 className="lp-title">Everything a server needs, in one bot</h2>
        <p className="lp-lede">
          All {MODULE_COUNT} modules ship with Proton — {COMMAND_COUNT} commands, {LOG_EVENT_COUNT}{' '}
          logged events, and exactly {OAUTH_SCOPES.length} OAuth scopes asked for. Each module has
          its own page and its own switch; turn one on and it is live in Discord immediately.
        </p>
      </header>

      <ul className="index-list">
        {CAPABILITIES.map((capability) => (
          <li className="index-row" key={capability.title}>
            <Icon name={capability.icon} />
            <span className="index-name">{capability.title}</span>
            <span className="index-body">{capability.body}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Showcases(): ReactElement {
  return (
    <div className="show-band">
      <section className="lp show" id="audit">
        <div className="show-inner">
          <div className="show-copy">
            <h2 className="lp-title">Read it back six months later</h2>
            <p className="lp-lede">
              A ban is not a message that scrolls away. Proton writes one numbered case per action —
              the moderator, the target, the reason they typed, the time — and keeps it for as long
              as it is in your server.
            </p>
            <ul className="show-list">
              <li>Reversals land back on the case they reverse, so nothing is rewritten.</li>
              <li>Filters live in the URL, so a search is a link you can send.</li>
              <li>Actions Proton took by itself are recorded the same way.</li>
            </ul>
            <a className="button button-discord" href="/invite">
              <Icon name="discord-logo" weight="fill" />
              Add to Discord
            </a>
          </div>
          <div className="show-figure">
            <ShotFrame shot={SHOTS.cases} />
          </div>
        </div>
      </section>

      <section className="lp show show-flip" id="modules">
        <div className="show-inner">
          <div className="show-copy">
            <h2 className="lp-title">Set it up on the web, run it in Discord</h2>
            <p className="lp-lede">
              No chains of setup commands in a channel nobody can read back. Every module is one
              page: a switch, its settings, and the reason beside the switch if it cannot run.
            </p>
            <ul className="show-list">
              <li>Roles and channels are picked from your server, not typed as raw ids.</li>
              <li>Unsaved work is never lost quietly — it blocks navigation and asks.</li>
              <li>Every change is audited with who made it and what it was before.</li>
            </ul>
            <Link to="/commands" className="button button-quiet">
              Browse the commands
              <Icon name="arrow-right" />
            </Link>
          </div>
          <div className="show-figure">
            <ShotFrame shot={SHOTS.modules} />
          </div>
        </div>
      </section>

      <section className="lp show" id="honesty">
        <div className="show-inner">
          <div className="show-copy">
            <h2 className="lp-title">When it cannot run, it says which permission is missing</h2>
            <p className="lp-lede">
              Discord will not tell a bot what it is allowed to do, so Proton never claims
              everything is fine. It names the exact permission or intent it is missing, and prints
              the path in Discord that fixes it.
            </p>
            <ul className="show-list">
              <li>A module that cannot run is never greyed out — its switch stays live.</li>
              <li>Every state colour is printed next to a word that says the same thing.</li>
              <li>Proton queues through a Discord outage rather than dropping the work.</li>
            </ul>
            <Link to="/faq" className="button button-quiet">
              How it handles failure
              <Icon name="arrow-right" />
            </Link>
          </div>
          <div className="show-figure">
            <ShotFrame shot={SHOTS.notRunning} />
          </div>
        </div>
      </section>
    </div>
  );
}

function CommandStrip(): ReactElement {
  const half = Math.ceil(TOP_LEVEL_COMMANDS.length / 2);
  const rows = [TOP_LEVEL_COMMANDS.slice(0, half), TOP_LEVEL_COMMANDS.slice(half)];

  return (
    <section className="strip" id="commands">
      <div className="strip-head">
        <h2 className="lp-title">{COMMAND_COUNT} commands, documented</h2>
        <Link to="/commands" className="button button-quiet">
          Browse the commands
          <Icon name="arrow-right" />
        </Link>
      </div>

      <div className="marquee" aria-hidden="true">
        {rows.map((row, index) => (
          <div
            className="marquee-row"
            key={row[0] ?? index}
            data-reverse={index === 1 || undefined}
          >
            <div className="marquee-track">
              {[0, 1].map((copy) => (
                <span className="marquee-run" key={copy}>
                  {row.map((command) => (
                    <span className="marquee-item mono" key={command}>
                      {command}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
