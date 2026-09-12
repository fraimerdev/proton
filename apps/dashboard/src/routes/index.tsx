import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging/config';
import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { Icon } from '../components/shell/icon.tsx';
import { ProtonMark } from '../components/shell/mark.tsx';
import { moduleArt } from '../components/shell/module-meta.ts';
import {
  COMMAND_COUNT,
  LOG_CATEGORY_COUNT,
  LOG_EVENT_COUNT,
  MODULE_COUNT,
  moduleNames,
  REPLACES,
} from '../components/site/catalogue.ts';
import { SitePage } from '../components/site/chrome.tsx';
import { landingCommands } from '../components/site/commands.ts';
import { FAQ, featured, QuestionList } from '../components/site/faq.tsx';
import {
  ModerationScene,
  RefusalScene,
  ServerLogScene,
  TicketPanelScene,
} from '../components/site/scene.tsx';
import { CaseFigure, LogRoutingFigure, TicketPanelFigure } from '../components/site/surface.tsx';
import { capitalised, inWords } from '../components/site/words.ts';
import { SITE_DESCRIPTION } from '../lib/site-meta.ts';

// Better Auth redirects a failed OAuth callback back here with these two, and until it had a route
// to land on the whole failure was a not-found page.
const doorSearchSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  notice: z.literal('invite-unavailable').optional(),
});

export const Route = createFileRoute('/')({
  validateSearch: zodValidator(doorSearchSchema),
  head: () => ({
    meta: [
      { title: 'Proton: the all-in-one Discord bot' },
      { name: 'description', content: SITE_DESCRIPTION },
    ],
  }),
  component: Home,
});

const SIGN_IN_FAILURES: Record<string, string> = {
  access_denied: 'Discord did not grant Proton access, so nothing was shared.',
  no_code: 'Discord sent you back without a sign-in code, so you are not signed in. Try again.',
  invalid_code:
    'Discord would not accept the sign-in code, which usually means it expired. Try signing in again.',
  unable_to_get_user_info:
    'Discord approved the sign-in but did not return your account, so you are not signed in. Try again.',
  no_callback_url:
    'The sign-in lost track of where to send you back. Start again from Login with Discord.',
};

export function signInFailure(code: string, description?: string): string {
  if (Object.hasOwn(SIGN_IN_FAILURES, code)) {
    const line = SIGN_IN_FAILURES[code];
    if (line) return line;
  }

  // A crafted link can put anything in this red banner, so only a short description is echoed.
  if (description && description.length <= 200) return description;

  return `Discord sign-in did not finish (${code}), so you are not signed in.`;
}

const MODULES_IN_WORDS = inWords(MODULE_COUNT);

const QUESTION_COUNT = FAQ.reduce((total, group) => total + group.questions.length, 0);

function Home(): ReactElement {
  const { error, error_description: description, notice } = Route.useSearch();

  return (
    <SitePage>
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <h1 className="hero-title">
              {capitalised(MODULES_IN_WORDS)} modules.
              <span className="hero-title-line">Every action gets a case number.</span>
            </h1>

            <p className="hero-sub">
              Moderation, anti-raid, tickets, levels and logs — {MODULES_IN_WORDS} modules and{' '}
              {COMMAND_COUNT} slash commands in one bot. Every module arrives switched off, and the
              case Proton writes names the moderator, the reason they typed and the time.
            </p>

            {error ? (
              <div className="alert-banner hero-alert" role="alert">
                <Icon name="warning-circle" weight="fill" />
                <span className="alert-banner-text">{signInFailure(error, description)}</span>
              </div>
            ) : null}

            {notice ? (
              <div className="alert-banner hero-alert" role="alert">
                <Icon name="warning-circle" weight="fill" />
                <span className="alert-banner-text">
                  Proton could not reach its own API to ask which permissions the invite should
                  request, so no invite was started and nothing was added to your server. Try again
                  in a minute.
                </span>
              </div>
            ) : null}

            <div className="hero-actions">
              <a className="button button-discord button-xl" href="/invite">
                <Icon name="discord-logo" weight="fill" />
                Add to Discord
              </a>
            </div>

            <p className="hero-fine">You need Manage Server in the server you are adding it to.</p>

            <p className="hero-links">
              <Link to="/faq" hash="permissions-asked">
                Why the invite asks for so many permissions
              </Link>
              <Link to="/dashboard">Already added it? Open the dashboard</Link>
            </p>
          </div>

          <CaseFigure />
        </div>
      </section>

      <Showcases />

      <ModulePages />

      <Commands />

      <Replaces />

      <section className="lp questions" id="questions">
        <div className="questions-split">
          <div className="questions-aside">
            <h2 className="lp-title">Questions worth asking before you add it</h2>
            <Link to="/faq" className="button button-quiet">
              Read all {QUESTION_COUNT} questions
              <Icon name="arrow-right" />
            </Link>
          </div>

          <QuestionList questions={featured()} />
        </div>
      </section>

      <section className="closer">
        <div className="closer-inner">
          <p className="closer-line">
            {capitalised(MODULES_IN_WORDS)} modules, none of them on until you say so. One consent
            screen in Discord, then the dashboard.
          </p>
          <a className="button button-discord" href="/invite">
            <Icon name="discord-logo" weight="fill" />
            Add to Discord
          </a>
        </div>
      </section>
    </SitePage>
  );
}

function browse(to: '/commands' | '/faq', label: string): ReactElement {
  return (
    <Link to={to} className="button button-quiet">
      {label}
      <Icon name="arrow-right" />
    </Link>
  );
}

function ModuleArt({ id }: { id: string }): ReactElement | null {
  const art = moduleArt(id);

  if (!art) return null;

  return (
    <img
      className="show-art"
      src={art}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      decoding="async"
    />
  );
}

function Points({ points }: { points: readonly string[] }): ReactElement {
  return (
    <ul className="show-list">
      {points.map((point) => (
        <li key={point}>
          <Icon name="check-circle" weight="fill" />
          <span>{point}</span>
        </li>
      ))}
    </ul>
  );
}

const MODERATION_POINTS: readonly string[] = [
  'The case id is stamped on the reply, and the case log takes it as a filter.',
  'An unban or a lifted timeout lands back on the case it undoes, rather than rewriting it.',
  'Actions Proton takes on its own are written down the same way.',
];

const TICKET_POINTS: readonly string[] = [
  'Each ticket type carries its own staff roles, intake form and claim rules.',
  'Transcripts are off until you turn them on, and kept for 30 days after that.',
  'Claiming, transferring and closing are all recorded.',
];

const LOG_POINTS: readonly string[] = [
  'Who did it is resolved and printed, not left as an id to look up.',
  `Message edits and deletions are opt-in, and archived for ${MESSAGE_LOG_RETENTION_DAYS} days.`,
  'Proton’s own actions are logged beside Discord’s.',
];

const HONESTY_POINTS: readonly string[] = [
  'A module that cannot run is never greyed out — its switch stays live.',
  'Every state colour has a word beside it saying the same thing.',
  'Through a Discord outage Proton queues the work rather than dropping it.',
];

function Showcases(): ReactElement {
  return (
    <section className="features" id="features">
      <div className="features-head">
        <div>
          <h2 className="lp-title">Three of the {MODULES_IN_WORDS}, up close.</h2>
        </div>
        <p className="features-lede">
          Switch on the ones your server needs. The rest stay off, and stay out of the way.
        </p>
      </div>

      <div className="show-rows">
        <section className="show show-caption" id="moderation">
          <figure className="scene">
            <ModerationScene />
            <figcaption>
              What /ban posts in the channel it was run in. The case id in the subtext is the one
              the log keeps.
            </figcaption>
          </figure>

          <div className="show-copy">
            <ModuleArt id="moderation" />
            <h3 className="show-title">Read a ban back six months later</h3>
            <p className="show-lede">
              A ban is not a message that scrolls away. Proton writes one numbered case per action —
              the moderator, the target, the reason they typed and the time — and keeps it.
            </p>
            <Points points={MODERATION_POINTS} />
          </div>
        </section>

        <section className="show show-pair" id="tickets">
          <div className="show-copy">
            <ModuleArt id="tickets" />
            <h3 className="show-title">Support that stays private, and gets written down</h3>
            <p className="show-lede">
              Post a panel and a member opens a ticket by pressing it: a channel only they and your
              support team can read. You set the panel up here, they press it in Discord.
            </p>
            <Points points={TICKET_POINTS} />
          </div>

          <div className="show-pair-figures">
            <TicketPanelFigure />
            <figure className="scene">
              <TicketPanelScene />
              <figcaption>
                What lands in Discord. Proton composes it from the settings beside it, so you know
                what the panel says before anybody presses it.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="show show-stack" id="logs">
          <div className="show-copy">
            <ModuleArt id="serverlog" />
            <h3 className="show-title">Every audit event, in the channel you choose</h3>
            <p className="show-lede">
              Discord’s own audit log, read and printed as it happens: {inWords(LOG_EVENT_COUNT)}{' '}
              events across {inWords(LOG_CATEGORY_COUNT)} categories, and any one of them can go
              somewhere of its own.
            </p>
          </div>

          <figure className="scene">
            <ServerLogScene />
            <figcaption>
              One of the {LOG_EVENT_COUNT}, as it arrives in the channel its category routes to.
            </figcaption>
          </figure>

          <Points points={LOG_POINTS} />
        </section>
      </div>

      <section className="honesty" id="honesty">
        <div className="honesty-copy">
          <h3 className="honesty-title">When it cannot act, it says which permission is missing</h3>
          <p className="honesty-lede">
            Discord will not tell a bot what it is allowed to do, so Proton checks first — and when
            the answer is no it says so in the channel, naming the permission under the name your
            own server settings use.
          </p>
          <ul className="honesty-points">
            {HONESTY_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <div className="honesty-cta">{browse('/faq', 'How it handles failure')}</div>
        </div>

        <figure className="scene">
          <RefusalScene />
          <figcaption>What Proton replies instead of going quiet</figcaption>
        </figure>
      </section>
    </section>
  );
}

function ModulePages(): ReactElement {
  return (
    <section className="preview" id="dashboard">
      <div className="preview-head">
        <div>
          <h2 className="lp-title">Every module gets its own page.</h2>
          <p className="preview-lede">
            Sign in with Discord, pick a server, and a module opens on controls built for that
            module: a routing table for logs, a ladder of consequences for warnings, a panel builder
            for tickets. Settings live here; the buttons and commands live in Discord.
          </p>
        </div>

        <Link to="/dashboard" className="button button-quiet">
          Open the dashboard
          <Icon name="arrow-right" />
        </Link>
      </div>

      <div className="preview-figure">
        <LogRoutingFigure />
      </div>
    </section>
  );
}

function Commands(): ReactElement {
  return (
    <section className="strip" id="commands">
      <div className="strip-head">
        <h2 className="lp-title">{COMMAND_COUNT} commands, every one documented</h2>
        <Link to="/commands" className="button button-quiet">
          Browse the commands
          <Icon name="arrow-right" />
        </Link>
      </div>

      <ul className="cmd-list strip-list">
        {landingCommands().map((command) => (
          <li className="cmd-row" key={command.usage}>
            <code className="cmd-usage">
              <b>{command.usage}</b>
              {command.args.map((arg) => (
                <span key={arg.name} className={arg.required ? 'cmd-arg cmd-arg-req' : 'cmd-arg'}>
                  {arg.required ? `<${arg.name}>` : `[${arg.name}]`}
                </span>
              ))}
            </code>
            <p className="cmd-desc">{command.description}</p>
            {command.permission ? (
              <span className="chip cmd-perm">
                <Icon name="lock-key" />
                {command.permission}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="strip-note">
        Ten of {COMMAND_COUNT}. Required arguments are written <code>&lt;like this&gt;</code> and
        optional ones <code>[like this]</code>, the way Discord shows them while you type. A command
        a role may not run is refused with the reason, not ignored.
      </p>
    </section>
  );
}

function Replaces(): ReactElement {
  return (
    <section className="compare" id="compare">
      <header className="compare-head">
        <h2 className="lp-title" id="compare-title">
          What you would otherwise install
        </h2>
        <p className="compare-lede">
          Servers reach this list one bot at a time. All {MODULES_IN_WORDS} of Proton’s modules are
          filed below under the bot you would otherwise add for that job — one install, one consent
          screen, one record.
        </p>
      </header>

      <div className="compare-panel">
        <table className="compare-table" aria-labelledby="compare-title">
          <thead>
            <tr>
              <th scope="col">Instead of</th>
              <th scope="col">
                <span className="compare-brand">
                  <ProtonMark size={18} />
                  Proton
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {REPLACES.map((row) => (
              <tr key={row.job}>
                <th scope="row">
                  {row.job}
                  <span className="compare-note">{row.note}</span>
                </th>
                <td data-label="Proton">
                  <span className="compare-modules">{moduleNames(row.modules).join(', ')}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="compare-plans">
        Three plan tiers — free, plus and pro — set the ceiling on how many entries some of those
        lists hold: ticket panels, tags, counters, saved templates. No module is gated by tier, and
        no prices are published yet.{' '}
        <Link to="/faq" hash="plans">
          What the tiers cap
        </Link>
      </p>
    </section>
  );
}
