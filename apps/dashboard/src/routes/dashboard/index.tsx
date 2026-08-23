import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { accessLabel, guildIconUrl, initialsOf } from '../../components/shell/app-shell.tsx';
import { Icon } from '../../components/shell/icon.tsx';
import { isAccessError } from '../../lib/errors.ts';
import { sessionQuery } from '../../lib/queries.ts';

export const Route = createFileRoute('/dashboard/')({
  loader: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery(sessionQuery());
    } catch (error) {
      if (isAccessError(error)) throw redirect({ to: '/' });
      throw error;
    }
  },
  component: GuildPicker,
});

function GuildPicker(): ReactElement {
  const { guilds } = useSuspenseQuery(sessionQuery()).data;

  return (
    <div className="plain-page">
      <div className="page">
        <Link to="/" className="back-link">
          <Icon name="arrow-left" />
          Proton
        </Link>

        <div className="page-head">
          <div className="page-heading">
            <h1 className="page-title">Your servers</h1>
          </div>
        </div>

        <p className="page-lede">
          These are the servers you own or hold Manage Server in, the ones Proton has been invited
          to first. It only ever acts on those.
        </p>

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
          <ul className="guild-list">
            {guilds.map((guild) => {
              const icon = guildIconUrl(guild);

              return (
                <li key={guild.id}>
                  <div className="guild-row" data-present={guild.present ? undefined : 'false'}>
                    <span className="guild-avatar">
                      {icon ? (
                        <img src={icon} alt="" width={38} height={38} />
                      ) : (
                        initialsOf(guild.name)
                      )}
                    </span>
                    <span className="guild-row-text">
                      <span className="guild-row-name">{guild.name}</span>
                      <span className="guild-row-role">
                        {accessLabel(guild)}
                        {guild.present ? null : ' · Proton is not in this server'}
                      </span>
                    </span>
                    <Link
                      to="/dashboard/$guildId"
                      params={{ guildId: guild.id }}
                      search={{}}
                      className="button button-quiet"
                    >
                      Open
                      <Icon name="arrow-right" />
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
