import {
  MESSAGE_CACHE_FALLBACK_TTL_MS,
  MESSAGE_LOG_RETENTION_DAYS,
} from '@proton/module-logging/config';

const MESSAGE_CACHE_DEFAULT_RETENTION_HOURS = MESSAGE_CACHE_FALLBACK_TTL_MS / 3_600_000;

import type { ReactElement } from 'react';

export function PrivacyPolicy(): ReactElement {
  return (
    <section className="prose">
      <h1>Privacy</h1>

      <p>
        Proton is a Discord bot and dashboard for server moderation. The operator of this Proton
        instance is the <strong>data controller</strong> for everything described below, within the
        meaning of the UK/EU GDPR and the EU Digital Services Act. Discord is a separate controller
        for the platform itself.
      </p>

      <h2>What Proton stores about a server</h2>
      <ul>
        <li>
          <strong>Server and module settings</strong> — the server’s id and name, which modules are
          on, and their configuration. Kept while Proton is in the server.
        </li>
        <li>
          <strong>Branding images</strong> — where a server sets Proton’s avatar or banner for that
          server, Proton stores the image file an admin uploaded, its type and size, and which admin
          uploaded it. Kept until the image is replaced, cleared, or Proton leaves the server, and
          used for one purpose: sending it to Discord as Proton’s profile picture in that server.
        </li>
        <li>
          <strong>Moderation cases</strong> — one record per action Proton takes: the action, the
          moderator’s user id, the target’s user id, the reason typed by the moderator, and when it
          happened. This is the moderation history the <code>Cases</code> page shows. It is kept
          while Proton is in the server, because a moderation log that expires is not a moderation
          log.
        </li>
        <li>
          <strong>Blocked members</strong> — when a security module is set to add an account to a
          server’s blocked list, Proton stores that account’s user id, the reason, which module
          added it, and the ids of the channel and message that caused it. Never the message text.
          It is kept until a moderator lifts it or Proton leaves the server, and is read for one
          purpose: refusing that account at the verification gate.
        </li>
        <li>
          <strong>Dashboard audit trail</strong> — every settings change made here, with who made
          it, what it was before and after, and a one-way hash of the IP address it came from. The
          address itself is never stored.
        </li>
        <li>
          <strong>Sign-in details</strong> — your Discord user id, username, avatar and the OAuth
          token used to read your server list. Proton requests only <code>identify</code>,{' '}
          <code>guilds</code> and <code>guilds.members.read</code>; it can read which servers you
          are in and your roles there, and nothing else about your account.
        </li>
        <li>
          <strong>Verification</strong> — where a server uses Proton&rsquo;s website to verify new
          members, opening the one-time link signs you in exactly as above. Proton checks that the
          link was issued to your Discord account and tells that server you passed. The link itself
          carries only the server id, your user id and its own expiry, and Proton keeps no record of
          the check beyond the role it hands out and the server&rsquo;s own log of it.
        </li>
      </ul>

      <h2>Message logging</h2>
      <p>
        Message edit and deletion logging is <strong>off unless a server admin turns it on</strong>,
        per server. While it is on, Proton records, for each edited or deleted message in that
        server:
      </p>
      <ul>
        <li>the message, channel and server ids;</li>
        <li>the author’s user id, where Discord provides it;</li>
        <li>whether the message was edited, deleted, or bulk-deleted;</li>
        <li>
          the message <strong>text</strong> — the new text of an edit, and the previous text where
          Proton had already seen it;
        </li>
        <li>when it happened.</li>
      </ul>
      <p>
        Attachments, images and voice from logged messages are never stored — the only images Proton
        keeps are the branding pictures an admin uploads for it, described above. Channels listed as
        ignored in the module’s settings are never recorded at all.
      </p>
      <p>
        <strong>These records are deleted after {MESSAGE_LOG_RETENTION_DAYS} days.</strong> They are
        stored in day-sized partitions and each day is dropped whole once it ages out, so expiry is
        not a best-effort cleanup that can quietly fall behind.
      </p>
      <p>
        Server admins who enable this are processing their members’ personal data and are
        responsible for telling their members that it is on.
      </p>

      <h2>Remembering recent message text</h2>
      <p>
        Separately from the {MESSAGE_LOG_RETENTION_DAYS}-day archive above, a server admin may
        switch on <strong>Remember recent message text</strong>. This is a second, independent
        opt-in and is <strong>off unless a server admin turns it on</strong>. While it is on, Proton
        keeps the text of recent messages, their author’s user id, and the file names and links of
        any attachments <strong>in memory</strong> for{' '}
        <strong>{MESSAGE_CACHE_DEFAULT_RETENTION_HOURS} hours</strong> by default, configurable
        between one hour and seven days.
      </p>
      <p>
        It exists so that an edit log can show what the text was before the edit, and a deletion log
        can show what was removed and who wrote it — neither of which Discord sends. Nothing here is
        written to disk, attachment <em>contents</em> are never copied, and switching the option off
        deletes the server’s remembered text immediately rather than waiting for it to expire.
      </p>

      <h2>Server logs posted into Discord</h2>
      <p>
        Server logs is a separate module, also{' '}
        <strong>off unless a server admin turns it on</strong>. When it is on, Proton writes an
        embed into a log channel that the admin chooses. Those embeds can contain personal data —
        message text, nicknames, user ids, and the name of whoever performed an action.
      </p>
      <p>
        <strong>
          Anything posted into a log channel is visible to anyone who can read that channel
        </strong>{' '}
        for as long as the message exists there. That audience is chosen by the server’s admins;
        Proton neither controls it nor can revoke it afterwards, and deleting data from Proton does
        not delete embeds already posted into Discord.
      </p>

      <h2>What Proton never does</h2>
      <ul>
        <li>No advertising, profiling, or selling of data.</li>
        <li>
          No message content is stored unless a server switches it on — either message logging, or
          the Honeypot module’s “Quote the message”, which copies the one message that sprang a trap
          into that server’s own incident log. Both are off by default.
        </li>
        <li>
          The browser never talks to Discord on your behalf — every Discord call is made by Proton’s
          own services, so a page you visit cannot act as you.
        </li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of the data Proton holds about you, ask for it to be corrected, or
        ask for it to be deleted. Moderation cases are the one category that may be retained against
        a deletion request: a server’s moderation history is kept in the legitimate interest of
        keeping that community safe, and erasing a case would remove the record of an action taken
        about someone else as much as about you. Removing Proton from a server ends all collection
        for it.
      </p>

      <p>
        Requests go to the operator of this Proton instance, at{' '}
        <a href="mailto:hello@fraimer.dev">hello@fraimer.dev</a>, and are answered within 30 days.
        Include your Discord user id, and the server’s id where the request concerns one server.
      </p>

      <p>
        <a href="/">Back to Proton</a>
      </p>
    </section>
  );
}
