import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging/config';
import type { ReactElement, ReactNode } from 'react';
import { SUPPORT_INVITE } from '../../lib/site-meta.ts';
import { Icon } from '../shell/icon.tsx';
import { LOG_CATEGORY_COUNT, LOG_EVENT_COUNT, MODULE_COUNT } from './catalogue.ts';

export interface Question {
  id: string;
  q: string;
  a: ReactNode;
}

export interface QuestionGroup {
  id: string;
  label: string;
  questions: readonly Question[];
}

export const FAQ: readonly QuestionGroup[] = [
  {
    id: 'start',
    label: 'Getting started',
    questions: [
      {
        id: 'what',
        q: 'What is Proton?',
        a: (
          <>
            <p>
              One Discord bot covering moderation, security and engagement, with this website as its
              only configuration surface. It ships with {MODULE_COUNT} modules in five categories —
              Moderation, Security, Engagement, Utility and Logging — and each one has its own
              switch, its own settings page and its own permission requirements.
            </p>
            <p>
              A server switches the modules it has on and off. It cannot add or remove them, and
              there is nothing to install beyond the bot itself.
            </p>
          </>
        ),
      },
      {
        id: 'add',
        q: 'How do I add it to my server?',
        a: (
          <p>
            Use <a href="/invite">Add Proton to a server</a>. Discord will ask you which server and
            show you the permissions Proton is requesting; you need <strong>Manage Server</strong>{' '}
            in that server to accept. Then sign in here with Discord and the server appears in your
            list.
          </p>
        ),
      },
      {
        id: 'permissions-asked',
        q: 'Why does the invite ask for so many permissions?',
        a: (
          <p>
            The invite asks for the union of what every loaded module needs, because Discord only
            offers one consent screen and there is no way to ask again later without a second
            invite. Proton never uses a permission a switched-off module would have needed. If you
            grant less than the invite asks for, the affected modules say so on their own pages
            rather than failing quietly.
          </p>
        ),
      },
      {
        id: 'defaults',
        q: 'Does Proton start doing things the moment it joins?',
        a: (
          <p>
            Some modules are on when Proton joins — the ones that only act when a moderator runs a
            command, or that protect the server without configuration. Everything that needs a
            channel, a role or a message from you is off until you set it up.{' '}
            <strong>Message logs, the only module that stores message text, is off</strong> and
            stays off until a server admin turns it on.
          </p>
        ),
      },
      {
        id: 'dashboard',
        q: 'Do I have to use the dashboard?',
        a: (
          <p>
            For configuration, yes — settings live here, not behind a chain of setup commands in
            chat. Day-to-day work happens in Discord: slash commands, buttons, ticket panels, role
            menus. The dashboard is a control surface, not a second Discord.
          </p>
        ),
      },
    ],
  },
  {
    id: 'data',
    label: 'Permissions and data',
    questions: [
      {
        id: 'scopes',
        q: 'What does signing in give Proton access to?',
        a: (
          <p>
            Three Discord OAuth scopes: <code>identify</code>, <code>guilds</code> and{' '}
            <code>guilds.members.read</code>. That is your account id, name and avatar; the list of
            servers you are in; and your roles in those servers. Nothing else about your account is
            readable, and your browser never talks to Discord — every Discord call is made by
            Proton&rsquo;s own services, so a page you visit cannot act as you.
          </p>
        ),
      },
      {
        id: 'messages',
        q: 'Does Proton read my messages?',
        a: (
          <>
            <p>
              Proton receives message content from Discord, because checking a message for spam,
              banned words or phishing links cannot be done without reading it. Reading is not
              storing.
            </p>
            <p>
              Message text is only written down when a server admin switches on{' '}
              <strong>Message logs</strong>, which is off by default. Those records are deleted
              after {MESSAGE_LOG_RETENTION_DAYS} days, in day-sized partitions that are dropped
              whole rather than swept. Attachments, images and voice are never stored at all.
            </p>
          </>
        ),
      },
      {
        id: 'stored',
        q: 'What does Proton keep about my server?',
        a: (
          <p>
            Server and module settings, one moderation case per action it takes, and an audit trail
            of every settings change made here — including a one-way hash of the IP address it came
            from, never the address itself. The full list, and what happens to each category when
            you ask for deletion, is in the <a href="/privacy">privacy policy</a>.
          </p>
        ),
      },
      {
        id: 'delete',
        q: 'Can I get my data deleted?',
        a: (
          <p>
            Yes, with one documented exception: a server&rsquo;s moderation cases may be retained
            against a deletion request, because a case records an action taken about someone else as
            much as about you, and a moderation log that can be erased on request is not a
            moderation log. Removing Proton from a server ends all collection for it.
          </p>
        ),
      },
      {
        id: 'logs-visible',
        q: 'Who can see what Proton posts into a log channel?',
        a: (
          <p>
            Everyone who can read that channel, for as long as the message exists there. That
            audience is chosen by your server&rsquo;s admins. Proton cannot revoke it, and deleting
            data from Proton does not unpost an embed that is already in Discord.
          </p>
        ),
      },
    ],
  },
  {
    id: 'running',
    label: 'Running it',
    questions: [
      {
        id: 'nothing-happened',
        q: 'I ran a command and nothing happened. What now?',
        a: (
          <p>
            That is a bug in Proton&rsquo;s terms, not an expected outcome, and the product is built
            so it should not be possible. Open the module&rsquo;s page: if it cannot run, the page
            names the exact missing permission or intent and the path in Discord to fix it. If the
            module is running, check the <strong>Permissions</strong> module — it decides which
            roles may run each of Proton&rsquo;s commands.
          </p>
        ),
      },
      {
        id: 'reverse',
        q: 'Can a moderation action be undone?',
        a: (
          <p>
            Yes. Unbanning, lifting a timeout or reversing a warning is recorded against the case it
            reverses, so the case shows both the original action and the reversal with who did each
            and when. The history is not rewritten.
          </p>
        ),
      },
      {
        id: 'automod',
        q: 'Does it conflict with Discord’s own AutoMod?',
        a: (
          <p>
            No — it uses it. Proton manages Discord&rsquo;s AutoMod rules for the checks Discord can
            block at the edge, before the message is ever posted, and handles the rest itself. Rules
            Proton creates or changes appear in your Discord audit log as Proton&rsquo;s work.
          </p>
        ),
      },
      {
        id: 'logs',
        q: 'How much does Server logs actually cover?',
        a: (
          <p>
            {LOG_EVENT_COUNT} events across {LOG_CATEGORY_COUNT} categories — server, channels,
            roles, members, messages, voice, moderation, invites, integrations, expressions,
            scheduled events, AutoMod and Proton&rsquo;s own actions. Each category routes to a
            channel you pick, and any single event can be sent somewhere else or switched off on its
            own.
          </p>
        ),
      },
      {
        id: 'outage',
        q: 'What happens when Discord has an outage?',
        a: (
          <p>
            Proton queues rather than drops. Gateway sessions survive a worker deploy, events
            redelivered after a reconnect are recognised as duplicates and not acted on twice, and
            work that could not be sent is retried rather than silently lost.
          </p>
        ),
      },
    ],
  },
  {
    id: 'account',
    label: 'Access and plans',
    questions: [
      {
        id: 'who',
        q: 'Who on my staff can open the dashboard?',
        a: (
          <p>
            Anyone the server grants <strong>Manage Server</strong>, or a staff role Proton can
            resolve through <code>guilds.members.read</code>. Every permission check happens on the
            server for every mutation, and every change is written to the audit trail with who made
            it and what it was before.
          </p>
        ),
      },
      {
        id: 'plans',
        q: 'Is there a paid plan?',
        a: (
          <p>
            Proton has three plan tiers — free, plus and pro — which set the ceiling on how many
            entries some modules&rsquo; lists may hold. A module that is switched on but not
            available on this server&rsquo;s tier says <em>Not on this plan</em> beside its switch
            rather than disappearing. No prices are published here yet.
          </p>
        ),
      },
      {
        id: 'remove',
        q: 'How do I remove Proton?',
        a: (
          <p>
            Kick or ban it from the server in Discord, the same as any other member. That ends all
            collection for that server immediately. Your settings and cases are kept so that
            re-adding it later does not start from nothing; ask the operator if you want them gone
            instead.
          </p>
        ),
      },
      {
        id: 'selfhost',
        q: 'Who runs this instance, and where do I ask?',
        a: (
          <p>
            Proton is operated by whoever deployed it, and that operator is the data controller for
            everything described in the <a href="/privacy">privacy policy</a> and the{' '}
            <a href="/terms">Terms of Service</a>. Discord is a separate controller for the platform
            itself. Questions, bug reports and deletion requests go to the{' '}
            <a href={SUPPORT_INVITE} rel="noreferrer noopener" target="_blank">
              support server
            </a>
            .
          </p>
        ),
      },
    ],
  },
];

export function QuestionList({ questions }: { questions: readonly Question[] }): ReactElement {
  return (
    <div className="faq-list">
      {questions.map((question) => (
        <details className="faq-item" key={question.id} id={question.id}>
          <summary>
            <span className="faq-q">{question.q}</span>
            <Icon name="caret-down" className="faq-mark faq-mark-shut" />
            <Icon name="caret-up" className="faq-mark faq-mark-open" />
          </summary>
          <div className="faq-a">{question.a}</div>
        </details>
      ))}
    </div>
  );
}

export const FEATURED_QUESTIONS: readonly string[] = [
  'permissions-asked',
  'messages',
  'nothing-happened',
  'automod',
  'plans',
];

export function featured(): Question[] {
  const all = FAQ.flatMap((group) => group.questions);

  return FEATURED_QUESTIONS.map((id) => all.find((question) => question.id === id)).filter(
    (question): question is Question => question !== undefined,
  );
}
