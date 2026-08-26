import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { Icon } from '../components/shell/icon.tsx';
import {
  COMMAND_COUNT,
  LOG_CATEGORY_COUNT,
  LOG_EVENT_COUNT,
  MODULE_COUNT,
  TOP_LEVEL_COMMANDS,
} from '../components/site/catalogue.ts';
import { SitePage } from '../components/site/chrome.tsx';
import { featured, QuestionList } from '../components/site/faq.tsx';
import {
  ModerationScene,
  RankCardScene,
  RefusalScene,
  ServerLogScene,
  StarboardScene,
  TicketPanelScene,
} from '../components/site/scene.tsx';
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

interface Feature {
  id: string;
  title: string;
  lede: string;
  points: readonly string[];
  scene: ReactElement;
  cta: ReactElement;
}

const invite = (
  <a className="button button-discord" href="/invite">
    <Icon name="discord-logo" weight="fill" />
    Add to Discord
  </a>
);

function browse(to: '/commands' | '/faq', label: string): ReactElement {
  return (
    <Link to={to} className="button button-quiet">
      {label}
      <Icon name="arrow-right" />
    </Link>
  );
}

const FEATURES: readonly Feature[] = [
  {
    id: 'moderation',
    title: 'Read it back six months later',
    lede: 'A ban is not a message that scrolls away. Proton writes one numbered case per action — the moderator, the target, the reason they typed, the time — and keeps it for as long as it is in your server.',
    points: [
      'The case id is stamped on the reply, so the ledger is searchable from Discord.',
      'Reversals land back on the case they reverse, so nothing is rewritten.',
      'Actions Proton took by itself are recorded the same way.',
    ],
    scene: <ModerationScene />,
    cta: invite,
  },
  {
    id: 'leveling',
    title: 'Levels, ranks and a card worth posting',
    lede: 'XP for talking and for time in voice, with role rewards at the levels you choose. /rank draws the member a card; /leaderboard ranks the server.',
    points: [
      'The card is drawn by Proton — pick a preset, an accent and a background.',
      'Voice XP is counted per session, not per message.',
      'Role rewards are granted the moment the level lands.',
    ],
    scene: <RankCardScene />,
    cta: browse('/commands', 'Browse the commands'),
  },
  {
    id: 'starboard',
    title: 'The good messages get a second life',
    lede: 'React with a star. Once enough people have, Proton reposts the message to the board with a link back to where it was said.',
    points: [
      'The count is recomputed, not incremented, so removed stars come off again.',
      'Attachments come along; the first image is shown in the post.',
      'Pick the emoji, the threshold and whether self-stars count.',
    ],
    scene: <StarboardScene />,
    cta: browse('/faq', 'How it handles failure'),
  },
  {
    id: 'tickets',
    title: 'Support that stays private and gets written down',
    lede: 'Post a panel and members open a ticket by pressing it. Each one is a channel only they and your support roles can read — configured on the web, pressed in Discord.',
    points: [
      'Ticket types carry their own staff roles, form fields and claim rules.',
      'Transcripts are optional, and kept for 30 days when you turn them on.',
      'Closing, claiming and transferring are all recorded.',
    ],
    scene: <TicketPanelScene />,
    cta: invite,
  },
  {
    id: 'logs',
    title: 'Every audit event, in the channel you choose',
    lede: `Discord's own audit log, read and routed. ${LOG_EVENT_COUNT} events across ${LOG_CATEGORY_COUNT} categories, each one able to go to its own channel.`,
    points: [
      'Who did it is resolved and printed, not left as an id to look up.',
      'Message edits and deletions are opt-in, and archived for 30 days.',
      'Proton’s own actions are logged beside Discord’s.',
    ],
    scene: <ServerLogScene />,
    cta: browse('/commands', 'Browse the commands'),
  },
  {
    id: 'honesty',
    title: 'When it cannot run, it says which permission is missing',
    lede: 'Discord will not tell a bot what it is allowed to do, so Proton never claims everything is fine. It names the exact permission it is missing, under the name your server settings use.',
    points: [
      'A module that cannot run is never greyed out — its switch stays live.',
      'Every state colour is printed next to a word that says the same thing.',
      'Proton queues through a Discord outage rather than dropping the work.',
    ],
    scene: <RefusalScene />,
    cta: browse('/faq', 'How it handles failure'),
  },
];

function Showcases(): ReactElement {
  return (
    <div className="show-band">
      {FEATURES.map((feature, index) => (
        <section
          className={`lp show${index % 2 === 1 ? ' show-flip' : ''}`}
          id={feature.id}
          key={feature.id}
        >
          <div className="show-inner">
            <div className="show-copy">
              <h2 className="lp-title">{feature.title}</h2>
              <p className="lp-lede">{feature.lede}</p>
              <ul className="show-list">
                {feature.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              {feature.cta}
            </div>
            <div className="show-figure">{feature.scene}</div>
          </div>
        </section>
      ))}
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
