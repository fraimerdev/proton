import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { listGuilds } from '../../server/modules.ts';

export const Route = createFileRoute('/guilds/')({
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

  if (guilds.length === 0) {
    return (
      <section className="panel">
        <h1>No servers</h1>
        <p>You do not administer any server Proton is in yet.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h1>Your servers</h1>
      <ul className="guild-list">
        {guilds.map((guild) => (
          <li key={guild.id}>
            <Link to="/guilds/$guildId/modules" params={{ guildId: guild.id }}>
              {guild.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
