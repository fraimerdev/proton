import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { listGuilds } from '../../server/modules.ts';

export const Route = createFileRoute('/dashboard/')({
  loader: async () => {
    try {
      return await listGuilds();
    } catch (error) {
      if (error instanceof Error && /forbidden|not signed in/i.test(error.message)) {
        throw redirect({ to: '/' });
      }
      throw error;
    }
  },
  component: GuildPicker,
});

function GuildPicker(): ReactElement {
  const { guilds } = Route.useLoaderData();
  const joined = guilds.filter((guild) => guild.joined);
  const absent = guilds.filter((guild) => !guild.joined);

  if (guilds.length === 0) {
    return (
      <section className="panel">
        <h1>No servers</h1>
        <p>You do not administer any Discord server.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h1>Your servers</h1>

      {joined.length > 0 ? (
        <ul className="guild-list">
          {joined.map((guild) => (
            <li key={guild.id}>
              <Link to="/dashboard/$guildId" params={{ guildId: guild.id }}>
                {guild.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>Proton is not in any server you administer yet.</p>
      )}

      {absent.length > 0 ? (
        <div className="subsection">
          <h2>Proton has not joined these</h2>
          <p className="field-description">
            Invite Proton to a server before configuring it — until it joins, nothing acts on the
            settings you save.
          </p>
          <ul className="guild-list guild-list-absent">
            {absent.map((guild) => (
              <li key={guild.id}>{guild.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
