import { MESSAGE_LOG_RETENTION_DAYS } from '@proton/module-logging/config';
import type { ReactElement } from 'react';

export function Terms(): ReactElement {
  return (
    <section className="prose">
      <h1>Terms of Service</h1>

      <p>
        These terms cover your use of <strong>Proton</strong> — the Discord bot and this dashboard.
        &ldquo;The operator&rdquo; below means whoever runs this Proton instance; they are also the
        data controller described in the <a href="/privacy">privacy policy</a>. Adding Proton to a
        server, or signing in here, means you accept these terms.
      </p>

      <h2>Who may use it</h2>
      <ul>
        <li>
          You must meet Discord&rsquo;s own minimum age for your country and comply with the{' '}
          <a href="https://discord.com/terms" rel="noreferrer noopener" target="_blank">
            Discord Terms of Service
          </a>{' '}
          and{' '}
          <a href="https://discord.com/guidelines" rel="noreferrer noopener" target="_blank">
            Community Guidelines
          </a>
          . Proton is a client of Discord&rsquo;s API and cannot grant you anything Discord does
          not.
        </li>
        <li>
          Adding Proton to a server requires the <strong>Manage Server</strong> permission in that
          server. By adding it you confirm you are authorised to bind that server to these terms.
        </li>
        <li>
          Configuring a server here requires <strong>Manage Server</strong>, or a staff role that
          server has granted. Access is re-checked against Discord on every change; it is not cached
          against a role you used to hold.
        </li>
      </ul>

      <h2>What the service is</h2>
      <p>
        Proton performs actions in Discord on your server&rsquo;s behalf — bans, kicks, timeouts,
        message deletions, role changes, channel changes, and the messages and embeds its modules
        post. It does this using the permissions your server granted it, and only for modules that
        server has switched on.
      </p>
      <p>
        <strong>Proton is a tool, not a moderator.</strong> Configuration decisions are yours: which
        modules run, what they act on, and how severely. The operator does not review, approve or
        take responsibility for how a server configures Proton or for the moderation decisions that
        result.
      </p>
      <p>
        Proton is not affiliated with, endorsed by, or sponsored by Discord Inc.
        &ldquo;Discord&rdquo; is a trademark of Discord Inc.
      </p>

      <h2>Your responsibilities as a server admin</h2>
      <ul>
        <li>
          <strong>Tell your members what you switched on.</strong> Message logging and Server logs
          process your members&rsquo; personal data. A server that enables them is processing that
          data as a controller and is responsible for telling its members. See the{' '}
          <a href="/privacy">privacy policy</a> for exactly what each stores and for how long.
        </li>
        <li>
          <strong>Choose the audience for log channels.</strong> Anything Proton posts into a
          channel is visible to everyone who can read that channel. Proton cannot revoke it once it
          is posted, and deleting data from Proton does not remove an embed already in Discord.
        </li>
        <li>
          <strong>Do not use Proton to break Discord&rsquo;s rules.</strong> That includes mass
          messaging or advertising, harassment, evading Discord&rsquo;s own enforcement, scraping
          member data, or automating anything Discord&rsquo;s Developer Policy forbids.
        </li>
        <li>
          <strong>Destructive actions are real everywhere.</strong> Proton has no rehearsal mode. A
          ban is a ban, a purge deletes messages, and a restore rewrites channels and roles. The one
          exception is <code>/backup restore</code>, which previews until you confirm it.
        </li>
        <li>
          <strong>Keep your own permissions sane.</strong> Proton can only act within the
          permissions and role position your server gives it, and it will say when that is not
          enough rather than working around it.
        </li>
      </ul>

      <h2>Acceptable use of this service</h2>
      <p>You agree not to:</p>
      <ul>
        <li>
          attempt to access servers, configuration or cases you do not administer, or to defeat the
          permission checks that stop you;
        </li>
        <li>
          automate, scrape or load-test this dashboard or the bot beyond ordinary use, or interfere
          with its availability for other servers;
        </li>
        <li>
          reverse engineer, resell, sublicense or re-host Proton, or present it as your own service;
        </li>
        <li>
          set Proton’s name, avatar, banner or bio in your server so that it impersonates Discord,
          Discord staff, another application, or a real person, or so that it carries sexual,
          hateful or unlawful imagery. Proton wears what you give it, in front of everyone in your
          server, and there is no age gate on a profile picture. We may revert branding and switch
          the feature off for a server at our discretion;
        </li>
        <li>
          use Proton to store or distribute unlawful content, or to process personal data unlawfully
          under the law that applies to you.
        </li>
      </ul>

      <h2>Availability</h2>
      <p>
        Proton is provided <strong>as is</strong>, with no uptime guarantee and no service level
        commitment. It depends on Discord&rsquo;s API, which fails, rate-limits and changes without
        notice. Proton is built to degrade predictably — it queues rather than drops, and names what
        it could not do — but it can still miss events, and it cannot act at all while Discord is
        unavailable.
      </p>
      <p>
        Modules may be added, changed or withdrawn. Where a change alters what a module stores or
        what permission it needs, the module&rsquo;s own page says so.
      </p>

      <h2>Plans and limits</h2>
      <p>
        A server sits on a plan tier that sets the ceiling on how many entries some modules&rsquo;
        lists may hold. A module that is switched on but not available on that tier says so beside
        its switch and stays switchable. No prices are published on this site; where the operator
        charges for a tier, the terms of that purchase are given at the point of purchase and are
        not part of this document.
      </p>

      <h2>Suspension and removal</h2>
      <p>
        The operator may suspend Proton&rsquo;s service to a server, or remove Proton from it, where
        that server is using it to break Discord&rsquo;s rules or these terms, or where continuing
        would put the service or other servers at risk. You may remove Proton from your server at
        any time by kicking or banning it in Discord, which ends all collection for that server
        immediately.
      </p>
      <p>
        Settings and moderation cases are retained after removal so that re-adding Proton does not
        start from nothing. Ask the operator if you want them deleted instead; the one category that
        may be retained against such a request is moderation cases, and the{' '}
        <a href="/privacy">privacy policy</a> explains why.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, the operator is not liable for indirect or consequential loss,
        for lost data or messages, for moderation outcomes in your server, or for anything caused by
        Discord&rsquo;s own outages or changes. Nothing here limits liability that cannot lawfully
        be limited — including for death or personal injury caused by negligence, or for fraud.
      </p>
      <p>
        Two things are worth stating plainly rather than burying: message-log records are deleted
        after {MESSAGE_LOG_RETENTION_DAYS} days and are not a backup, and Proton&rsquo;s snapshots
        of your channels and roles are a convenience, not an archive. Do not rely on either as your
        only copy.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        These terms may change as Proton changes. Where a change materially affects what Proton does
        with your server&rsquo;s data or what you are agreeing to, the operator will make that
        visible before it takes effect. Continuing to use Proton after a change means you accept it.
      </p>

      <h2>Contact and governing law</h2>
      <p>
        Questions, deletion requests and complaints go to the operator of this Proton instance. The
        law and courts that govern these terms are those of the operator&rsquo;s own jurisdiction,
        which the operator names alongside their contact details.
      </p>

      <p>
        <a href="/">Back to Proton</a>
      </p>
    </section>
  );
}
