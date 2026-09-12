import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import {
  accessLabel,
  guildIconUrl,
  initialsOf,
  type ShellUser,
} from '../../components/shell/app-shell.tsx';
import { Icon } from '../../components/shell/icon.tsx';
import { ProtonMark } from '../../components/shell/mark.tsx';
import { SIGN_OUT_FAILED, useSignOut } from '../../components/shell/sign-out.ts';
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
        throw redirect({ to: '/signin', search: { redirect: DEFAULT_CALLBACK } });

      throw error;
    }
  },
  head: () => ({ meta: [{ title: documentTitle('Your servers') }] }),
  component: GuildPicker,
  errorComponent: GuildPickerError,
});

function PickerBar({ user }: { user?: ShellUser }): ReactElement {
  const { signOut, failed } = useSignOut();

  return (
    <header className="picker-bar">
      <div className="picker-bar-inner">
        <Link to="/" className="picker-brand">
          <ProtonMark size={24} />
          Proton
        </Link>

        <div className="picker-account">
          {user ? (
            <span className="picker-user">
              <span className="picker-user-avatar" aria-hidden="true">
                {user.image ? (
                  <img src={user.image} alt="" width={24} height={24} decoding="async" />
                ) : (
                  initialsOf(user.name)
                )}
              </span>
              <span className="picker-user-name" title={user.name}>
                <span className="sr-only">Signed in as </span>
                {user.name}
              </span>
            </span>
          ) : null}

          <button type="button" className="button button-quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>

      {failed ? (
        <p className="picker-bar-failure" role="alert">
          {SIGN_OUT_FAILED}
        </p>
      ) : null}
    </header>
  );
}

// Access errors redirect to the door, so anything reaching here is Discord or Proton failing to
// answer. Without this the router's own default renders, which names neither.
function GuildPickerError({ error }: { error: Error }): ReactElement {
  return (
    <div className="picker-page">
      <PickerBar />

      <main className="picker-main">
        <h1 className="picker-title">Your servers did not load</h1>

        <div className="gap-card picker-gap">
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
      </main>
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
      <span className="server-top">
        <span className="server-crest" aria-hidden="true">
          {icon ? (
            <img src={icon} alt="" width={42} height={42} decoding="async" />
          ) : (
            initialsOf(guild.name)
          )}
        </span>

        <span className="server-who">
          <span className="server-name" title={guild.name}>
            {guild.name}
          </span>
          <span className="server-meta">{accessLabel(guild)}</span>
        </span>
      </span>

      <span className="server-bar">
        <span className="server-badge" data-tone={guild.present ? 'in' : undefined}>
          {guild.present ? 'Added' : absent ? 'Not added' : 'Not checked'}
        </span>

        {guild.present ? (
          <Link
            to="/dashboard/$guildId"
            params={{ guildId: guild.id }}
            search={{}}
            className="server-button"
            // Five links reading "Configure" is what a screen reader's link list shows without
            // this, and the name beside it is a sibling the link never announces.
            aria-label={`Configure ${guild.name}`}
          >
            Configure
            <Icon name="arrow-right" />
          </Link>
        ) : invite ? (
          // A new tab: Discord takes the whole authorisation flow over, and running it in this one
          // loses an admin their place in the list they were reading.
          <a
            className="server-button"
            href={botInviteUrl(invite, guild.id)}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={
              absent
                ? `Add Proton to ${guild.name} — Proton is not in this server`
                : `Add Proton to ${guild.name}`
            }
          >
            Add Proton
            <Icon name="arrow-right" />
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
  const { guilds, invite, presenceKnown, user } = useSuspenseQuery(sessionQuery()).data;

  return (
    <div className="picker-page">
      <PickerBar user={user} />

      <main className="picker-main">
        <h1 className="picker-title">Choose a server</h1>
        <p className="picker-sub">
          Every server you own or hold Manage Server in. Proton has to be in a server before its
          settings open, so add it to the ones it is not in yet.
        </p>

        {presenceKnown ? null : (
          <div className="alert-banner picker-alert" role="status">
            <Icon name="warning-circle" weight="fill" />
            <span className="alert-banner-text">
              Proton could not check which of these servers it is in, so none of them offer
              Configure. Reload the page to try again.
            </span>
          </div>
        )}

        {guilds.length === 0 ? (
          <div className="card server-empty">
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
      </main>
    </div>
  );
}
