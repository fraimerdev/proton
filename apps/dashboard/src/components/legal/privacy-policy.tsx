import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging';
import type { ReactElement } from 'react';

export function PrivacyPolicy(): ReactElement {
  return (
    <section className="panel prose">
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
          <strong>Moderation cases</strong> — one record per action Proton takes: the action, the
          moderator’s user id, the target’s user id, the reason typed by the moderator, and when it
          happened. This is the moderation history the <code>Cases</code> page shows. It is kept
          while Proton is in the server, because a moderation log that expires is not a moderation
          log.
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
        Attachments, images and voice are never stored. Channels listed as ignored in the module’s
        settings are never recorded at all.
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

      <h2>What Proton never does</h2>
      <ul>
        <li>No advertising, profiling, or selling of data.</li>
        <li>No message content is stored unless message logging is switched on for that server.</li>
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

      <p>Requests go to the operator of this Proton instance.</p>

      <p>
        <a href="/">Back to sign in</a>
      </p>
    </section>
  );
}
