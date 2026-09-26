import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProsePage } from '../components/site/prose.tsx';
import { documentTitle } from '../lib/document-title.ts';
import { SUPPORT_INVITE } from '../lib/site-meta.ts';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: documentTitle('Privacy') }] }),
  component: Privacy,
});

function SupportServer(): ReactElement {
  return (
    <a href={SUPPORT_INVITE} target="_blank" rel="noreferrer">
      Proton’s support server
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function Privacy(): ReactElement {
  return (
    <ProsePage
      title="Privacy"
      updated="2026-09-24"
      related={{ to: '/terms', label: 'Terms of service' }}
      sections={[
        {
          id: 'scope',
          heading: 'Who this covers',
          body: (
            <p>
              This policy covers Proton, the Discord bot, and its website at prtn.xyz, including the
              dashboard. It applies to administrators who set Proton up, to members of servers
              Proton is in, and to anyone who signs in to verify, to appeal or to apply. Each
              server’s administrators choose which features run there; this page says what each one
              keeps.
            </p>
          ),
        },
        {
          id: 'signing-in',
          heading: 'Signing in with Discord',
          body: (
            <>
              <p>
                Signing in goes through Discord, and Proton asks for two permissions:{' '}
                <code>identify</code>, which shows Proton your Discord profile, including your user
                ID, username, display name, avatar and settings such as your language, and{' '}
                <code>guilds</code>, for the servers you are in and your permissions in each. Proton
                keeps only what is listed below. It doesn’t ask for your email address; before 18
                September 2026 sign-in also asked for it, and the addresses Proton had stored have
                been deleted.
              </p>
              <p>
                Administrators sign in to use the dashboard. Members sign in to verify on the
                website, to submit an appeal, or to fill in and follow their applications, when
                their server uses those features. Either way, Proton keeps:
              </p>
              <ul>
                <li>
                  Your Discord user ID, and your display name (or username) and avatar link as they
                  were when you first signed in.
                </li>
                <li>
                  The tokens Discord issues, so Proton can check your servers, your permissions in
                  each and your current name and avatar whenever you use the dashboard. Your server
                  list itself isn’t stored.
                </li>
                <li>
                  A session, held in a cookie, that lasts 7 days and is extended while you keep
                  using the site. Proton doesn’t record your IP address or browser with it.
                </li>
              </ul>
              <p>These are kept until deletion is requested. Signing out ends only the session.</p>
            </>
          ),
        },
        {
          id: 'from-discord',
          heading: 'What Proton receives from Discord',
          body: (
            <>
              <p>
                Proton uses the Server Members and Message Content intents. For each server it is
                in, Discord sends it events such as messages being sent, edited and deleted, members
                joining, leaving and changing nickname or roles, bans, role, channel and thread
                changes, reactions, polls, voice channel moves, audit log entries and Discord
                AutoMod actions. It also receives interactions: slash commands, Apps menu commands,
                button presses and what people type into Proton’s forms. It doesn’t use the Presence
                intent, so it never sees online status or activity, and it doesn’t receive direct
                messages.
              </p>
              <p>
                Every event passes through a queue before Proton’s modules handle it. The queue is
                trimmed continuously and keeps events for about a day, whatever is switched on.
                Events that keep failing to process are set aside for about a week so the fault can
                be found. The queue’s store can hold trimmed events in its on-disk log until it next
                compacts that log.
              </p>
              <p>
                Automod and the phishing filter read message text to decide whether to act; Honeypot
                acts on any message posted in a bait channel, whatever it says. Reading a message
                doesn’t keep it, but when Automod or the phishing filter acts, the case names what
                matched, such as a blocked domain, an invite code, a file name or the words
                Discord’s AutoMod flagged.
              </p>
            </>
          ),
        },
        {
          id: 'every-server',
          heading: 'What Proton keeps for every server',
          body: (
            <ul>
              <li>The server’s ID, name and language, and when Proton joined or left it.</li>
              <li>The settings saved for each module and each command, and who last saved them.</li>
              <li>
                A record of the actions Proton takes, such as a ban, a timeout, a role change or
                some of the messages it posts: who or what triggered it, who it affected, the reason
                and when. The record holds what Proton actually did, so a message it posts, like a
                starboard repost or a welcome message, is kept there. Administrators see these as
                cases.
              </li>
              <li>
                A record of every dashboard change: who made it, when, and the settings before and
                after. It stores a keyed one-way hash of the IP address the change came from, never
                the address itself.
              </li>
              <li>
                A copy of the server’s channels and roles, permission overwrites included, which the
                Backup module saves from. It is replaced whenever Discord sends a fresh copy.
              </li>
              <li>
                Cached details such as the owner, roles, channels and member count, dropped after 7
                days without an update, and members’ names and avatars, cached for 6 hours when a
                feature needs them.
              </li>
            </ul>
          ),
        },
        {
          id: 'features',
          heading: 'What features keep when they are on',
          body: (
            <>
              <p>
                Where no period is given, it is kept until deletion is requested. Administrators can
                delete only a few of these themselves, such as tags and uploaded images.
              </p>
              <ul>
                <li>
                  <strong>Logging</strong> keeps a record of edited and deleted messages, including
                  their text where Proton has it, for 30 days.{' '}
                  <strong>Remember recent message text</strong> keeps recent messages’ text, author
                  and attachment links for between 1 hour and 7 days, as the server chooses, or for
                  a day after the latest edit when Server Logs is on. Switching it off clears it at
                  once; switching off Logging instead leaves it to run out on its own.
                </li>
                <li>
                  <strong>Tickets</strong> keep each ticket’s opener, the staff who handled it,
                  anyone added to it, its subject, form answers, close reason, and rating with any
                  comment, as well as the members staff bar from opening tickets and why. With
                  message capture on, the ticket’s messages are deleted 30 days after they are
                  captured. Transcripts posted to a channel or sent by DM are Discord messages,
                  which Proton doesn’t delete.
                </li>
                <li>
                  <strong>Appeals</strong> keep each appeal, the member’s written answers and the
                  decision.
                </li>
                <li>
                  <strong>Applications</strong> keep each application: who sent it, the form and the
                  version of it they answered, their answers, messages between staff and the
                  applicant, the status and decision with who made it and any reason, and staff
                  notes and votes. Answers are saved as you fill in a form, in Discord or on the
                  website. A draft nobody has changed for the server’s draft expiry, 30 days unless
                  the server changes it, is deleted. The answers, your name as it was when you
                  applied, the messages, staff notes and the decision reason are deleted a set
                  number of days after the application is decided, withdrawn or expires, 30 unless
                  the server changes it, and Proton takes the answers off its review card in Discord
                  at the same time. A minimal record stays: the reference number, form, status,
                  dates, and who reviewed and decided it. Staff with the right role can delete an
                  applicant’s applications sooner. Forms never take files, so Proton never downloads
                  any; they can ask for links, which Proton doesn’t open. Proton DMs applicants
                  updates when the server allows it, but DMs are optional: you can always check your
                  applications on the website.
                </li>
                <li>
                  <strong>User reports</strong> keep each report: who filed it and who it is about,
                  how it was filed, the reason picked from the server’s list, its status, the
                  decision with who made it and any internal staff note, linked cases, and a
                  timeline of what happened to it. The copy of the reported message and of any
                  linked messages, attachment names and links, what the reporter wrote and the note
                  staff sent them are removed 30 days after the report is resolved, or 90 days after
                  it was filed if that is sooner. Proton never downloads attached files, and
                  Discord’s links to them expire. Report automation keeps each rule that fired, the
                  reports behind it and what each action did. A report still being filled in is held
                  for 15 minutes, or an hour when it was started with a reaction. The staff card and
                  the forwarded copy of a reported message are Discord messages in the server’s
                  report channel, which stay until staff or the server’s closing setting delete
                  them; a card moved to an archive channel stays there.
                </li>
                <li>
                  <strong>Moderation</strong> keeps each timeout it applies and when it ends, so it
                  can keep the timeout in place until then. When a member is punished from a
                  message, with Punish author or by accepting a report about that message, the
                  message and its attachment links are attached to the case as proof and kept for 30
                  days. With Keep recent messages for cases on, it also holds each member’s recent
                  messages and their attachment links, up to 5 per channel for an hour, and deleted
                  ones for 30 minutes; when a member is punished, those messages are attached to the
                  case and kept for 30 days too. Punished members are sent a direct message only if
                  the server switches that on.
                </li>
                <li>
                  <strong>Leveling</strong> keeps each member’s XP, level, message and voice totals,
                  when they last earned XP and a record of XP given by other features, plus daily
                  activity counts for 31 days; if Leveling is switched off, those counts stay until
                  it is switched back on. While a member is in voice, it notes the channel and when
                  they joined, for up to 24 hours. Members can see each other’s rank and the
                  leaderboard.
                </li>
                <li>
                  <strong>Achievements</strong>, when on, keeps hourly counts of each member’s
                  counted messages, reactions, voice minutes and Leveling XP per channel for 365
                  days, and the ID, channel and time of each counted message for about 3 days and of
                  each counted reaction for about 9 days, so nothing counts twice. It records which
                  messages reached the starboard, giveaway entries and wins, and when members
                  started boosting, while the module is on, and keeps those records after it is
                  switched off, so none of them counts twice if it is switched back on. It keeps
                  each member’s progress, the achievements they earned with the requirements and
                  rewards at the time, whether each reward was given and why not, resets and who
                  made them, and each member’s join and boost dates until 30 days after they leave.
                  While a member is in voice it notes the channel and when they joined. It keeps
                  badge images an administrator uploads; while Achievements is on, an image no
                  achievement uses is removed a day or two later. Anyone in the server can see
                  achievements with <code>/achievements</code> and on rank cards.
                </li>
                <li>
                  <strong>Giveaways</strong> keep each giveaway, who entered and with how many
                  entries, and a note taken at entry of the member’s roles, when they joined,
                  whether they boost and whether they have an avatar, to check requirements. They
                  also keep the winners, entries staff add with a reason, and members barred from
                  giveaways with a reason.
                </li>
                <li>
                  <strong>Suggestions</strong> keep each suggestion and its author, even when the
                  server posts it anonymously, and each member’s vote.
                </li>
                <li>
                  <strong>Join Roles</strong>, with Restore roles on rejoin on, keeps the roles each
                  member has, so it can give them back if they leave and come back. A role sync
                  keeps who started it for up to a day while it runs, and its result (how many
                  members it updated or skipped, never which ones) for up to 180 days.
                </li>
                <li>
                  <strong>Reminders</strong> keep the reminder text and when it is due, including
                  after it is delivered. <strong>Tags</strong> keep the tag text and who created and
                  last edited it. <strong>Polls</strong> keep the question and who started it;
                  answers and votes stay with Discord.
                </li>
                <li>
                  <strong>AFK</strong> keeps your away reason, your nickname before the tag, and the
                  pings you miss, which are cleared when you come back. An away status ends by
                  itself after 30 days.
                </li>
                <li>
                  <strong>Honeypot</strong> keeps who was caught in a bait channel and, if the
                  server blocks them, the block and any reason for lifting it. With a wait before
                  acting, the bait message is held until Proton acts, at most 7 days later, or until
                  deletion is requested if acting keeps failing.
                </li>
                <li>
                  <strong>Verification</strong> keeps a captcha until it is solved or expires, after
                  5 minutes unless the server sets longer. It keeps a quarantined member’s earlier
                  roles and the moderator’s reason until <code>/quarantine remove</code> gives every
                  role back, or until deletion is requested if that never happens.
                </li>
                <li>
                  <strong>Temporary Voice Channels</strong> keep each channel’s owner and their
                  trust and block lists until the channel closes, and which voice channel members
                  are in for up to 24 hours.
                </li>
                <li>
                  <strong>Backup</strong> keeps snapshots of roles and channels and who made them; a
                  server keeps its newest 10, or up to 25 if it chooses. <strong>Branding</strong>{' '}
                  keeps the avatar and banner an administrator uploads.
                </li>
              </ul>
            </>
          ),
        },
        {
          id: 'who-sees',
          heading: 'Who can see it',
          body: (
            <ul>
              <li>
                A server’s administrators, meaning its owner and anyone with Administrator or Manage
                Server, can see its settings, cases and the messages attached to them, user reports
                with their evidence, blocked members, tags, tickets, the Leveling leaderboard and
                each member’s achievements in the dashboard.
              </li>
              <li>
                Members see what features post in Discord, such as rank cards, leaderboards,
                starboard reposts and suggestions, and their own reminders. Staff can look up some
                of it with Proton’s commands, such as a giveaway’s entrants.
              </li>
              <li>
                Moderators see appeals and logs in the channels the server sends them to. The record
                of dashboard changes isn’t shown in the dashboard. With Server Logs on, each
                settings change and each module switched on or off is posted to a channel the server
                chooses, naming who made it and which settings changed.
              </li>
              <li>
                Applications are read by the staff on each form’s review team and by the server’s
                administrators, in the dashboard and on the review cards Proton posts in the
                server’s review channel. Anyone who can read that channel sees what a card shows,
                and a card shows answers only when the channel is limited to the review team. With
                Server Logs on, its log channel also shows when an application is sent or decided,
                naming the applicant and the form but never the answers. Applicants see their own
                applications and the messages staff send them, never staff notes or votes.
              </li>
              <li>
                User reports are posted to the report channel the server picks, so anyone who can
                read it sees who filed each report, what they wrote and part of the reported
                message. Reviewers, meaning administrators and members with a reviewer role, can
                open a report’s evidence in Discord, and see a reported message there only if they
                can read the channel it was in. Proton doesn’t tell members who reported them.
              </li>
              <li>
                Proton’s operator can access the server Proton runs on, including the database,
                caches, logs and backups, to run and support the service.
              </li>
            </ul>
          ),
        },
        {
          id: 'browser',
          heading: 'Cookies and your browser',
          body: (
            <>
              <p>
                Signing in sets a session cookie that lasts 7 days, and a short-lived cookie while
                you sign in. There are no advertising or analytics cookies and no third-party
                trackers.
              </p>
              <p>
                Fonts are served from Proton’s own site. Avatars, server icons and custom emoji load
                from Discord’s image servers, which see your IP address as they would for any image.
                When the dashboard previews a message, any image linked in it loads from wherever it
                is hosted. Proton’s web server logs each page request, including your IP address and
                browser, for security and troubleshooting.
              </p>
            </>
          ),
        },
        {
          id: 'where',
          heading: 'Where data lives',
          body: (
            <>
              <p>
                Proton runs on a single server that its operator rents, and its database and caches
                live there. The database is backed up daily, and backups on that server are deleted
                after 15 days.
              </p>
              <p>
                Discord provides the platform, its API and the image servers mentioned above. Proton
                also downloads public lists of phishing sites, which sends nothing about you. Proton
                doesn’t sell data or share it with advertisers or data brokers.
              </p>
            </>
          ),
        },
        {
          id: 'deletion',
          heading: 'Removing data and asking questions',
          body: (
            <>
              <p>
                Removing Proton from a server stops it receiving that server’s events and clears its
                cached server details, its copy of the channels and roles, and any remembered
                message text. Anything kept for a set period still expires on schedule. Everything
                else stays until deletion is requested.
              </p>
              <p>
                To have a server’s data deleted, its owner can ask in <SupportServer /> with the
                server ID. To find out what Proton holds about you, or to have your sign-in data
                deleted, ask there with your Discord user ID. Deleted data can remain in backups for
                up to 16 days.
              </p>
            </>
          ),
        },
        {
          id: 'changes',
          heading: 'Changes',
          body: (
            <p>
              This policy changes as Proton does, and the date at the top says when it last did. The{' '}
              <Link to="/terms">terms of service</Link> cover how Proton may be used.
            </p>
          ),
        },
      ]}
    />
  );
}
