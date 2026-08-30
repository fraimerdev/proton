import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { guildIconUrl, initialsOf } from '../../components/shell/app-shell.tsx';
import { Icon } from '../../components/shell/icon.tsx';
import { DEFAULT_CALLBACK } from '../../lib/callback-url.ts';
import { documentTitle } from '../../lib/document-title.ts';
import { isAccessError } from '../../lib/errors.ts';
import type { SessionGuild } from '../../lib/guild-access.ts';
import { type BotInvite, botInviteUrl } from '../../lib/invite.ts';
import { sessionQuery } from '../../lib/queries.ts';

export const Route = createFileRoute('/dashboard/')({
  loader: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery(sessionQuery());
    } catch (error) {
      if (isAccessError(error))
        throw redirect({
          href: `/api/auth/signin/discord?redirect=${encodeURIComponent(DEFAULT_CALLBACK)}`,
          reloadDocument: true,
        });

      throw error;
    }
  },
  head: () => ({ meta: [{ title: documentTitle('Your servers') }] }),
  component: GuildPicker,
  errorComponent: GuildPickerError,
});

// Access errors redirect to the door, so anything reaching here is Discord or Proton failing to
// answer. Without this the router's own default renders, which names neither.
function GuildPickerError({ error }: { error: Error }): ReactElement {
  return (
    <div className="plain-page">
      <div className="page">
        <Link to="/" className="back-link">
          <Icon name="arrow-left" />
          Proton
        </Link>

        <div className="page-head">
          <div className="page-heading">
            <h1 className="page-title">Your servers did not load</h1>
          </div>
        </div>

        <div className="gap-card">
          <div className="gap-body">
            <span className="gap-head">
              <Icon name="warning-circle" weight="fill" className="state-blocked" />
              <span className="gap-name">Proton could not read your server list</span>
            </span>
            <p className="gap-text" role="alert">
              {error.message}
            </p>
            <span className="where">
              <Icon name="arrow-elbow-down-right" />
              This list comes from Discord. Signing out and back in usually clears it.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GuildCard({
  guild,
  invite,
  presenceKnown,
}: {
  guild: SessionGuild;
  invite: BotInvite | null;
  presenceKnown: boolean;
}): ReactElement {
  const icon = guildIconUrl(guild, 256);

  // Only a checked absence earns the grey treatment and the words that go with it. When Discord
  // could not be asked, the card stays ordinary and the banner above the grid carries the doubt.
  const absent = presenceKnown && !guild.present;

  return (
    <li className="server-card" data-present={absent ? 'false' : undefined}>
      {/* The card's colour is the server's own icon, blown up and blurred under the whole of it.
          Two <img> for one src: the browser decodes it once and the second costs only a paint, and
          the alternative — one element blurred through ::before — cannot blur a background-image. */}
      {icon ? (
        <img className="server-wash" src={icon} alt="" aria-hidden="true" decoding="async" />
      ) : (
        <span className="server-wash server-wash-blank" aria-hidden="true" />
      )}

      <span className="server-hero">
        <span className="server-crest">
          {icon ? (
            <img src={icon} alt="" width={72} height={72} decoding="async" />
          ) : (
            initialsOf(guild.name)
          )}
        </span>
      </span>

      <span className="server-bar">
        <span className="server-name" title={guild.name}>
          {guild.name}
        </span>

        {guild.present ? (
          <Link
            to="/dashboard/$guildId"
            params={{ guildId: guild.id }}
            search={{}}
            className="button server-button"
            // Five links reading "Manage" is what a screen reader's link list shows without this,
            // and the name beside it is a sibling the link never announces.
            aria-label={`Manage ${guild.name}`}
          >
            Manage
          </Link>
        ) : invite ? (
          // A new tab: Discord takes the whole authorisation flow over, and running it in this one
          // loses an admin their place in the list they were reading.
          <a
            className="button button-quiet server-button"
            href={botInviteUrl(invite, guild.id)}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={
              absent
                ? `Proton is not in this server — invite it to ${guild.name}`
                : `Invite Proton to ${guild.name}`
            }
          >
            Invite
          </a>
        ) : (
          // The api could not say which permissions to ask Discord for. A button that builds the
          // wrong invite is worse than a card that says why there is no button.
          <span className="server-unavailable">
            {absent ? 'Proton is not in this server' : 'Proton could not check this server'}
          </span>
        )}
      </span>
    </li>
  );
}

function GuildPicker(): ReactElement {
  const { guilds, invite, presenceKnown } = useSuspenseQuery(sessionQuery()).data;

  return (
    <div className="picker-page">
      <div className="page">
        <Link to="/" className="back-link">
          <Icon name="arrow-left" />
          Proton
        </Link>

        <div className="picker-head">
          <h1 className="picker-title">Select a server</h1>
          <p className="picker-sub">
            Pick a server to configure, or invite Proton to one it is not in yet.
          </p>
        </div>

        {presenceKnown ? null : (
          <div className="alert-banner" role="status">
            <Icon name="warning-circle" weight="fill" />
            <span className="alert-banner-text">
              Proton could not check which of these servers it is in, so none of them offer Manage.
              Reload the page to try again.
            </span>
          </div>
        )}

        {guilds.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <span className="tile">
                <Icon name="users-three" />
              </span>
              <span className="empty-state-title">No servers to configure.</span>
              <p className="status">
                Discord lists no server where you are the owner or hold Manage Server. Ask that
                server’s owner for the permission, then reload this page.
              </p>
            </div>
          </div>
        ) : (
          <ul className="server-grid">
            {guilds.map((guild) => (
              <GuildCard
                key={guild.id}
                guild={guild}
                invite={invite}
                presenceKnown={presenceKnown}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
