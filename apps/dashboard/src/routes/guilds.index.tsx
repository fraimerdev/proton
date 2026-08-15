import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { listGuilds } from '../server/modules.ts';

export const Route = createFileRoute('/guilds/')({
  loader: async () => {
    try {
      return await listGuilds();
    } catch (error) {
      // `requireSession` throws for a signed-out visitor. Letting that escape
      // renders a 500, which tells someone who simply is not logged in that the
      // site is broken. Anything else is a real fault and must keep propagating
      // rather than being swallowed into a redirect loop.
      if (error instanceof Error && /forbidden|not signed in/i.test(error.message)) {
        throw redirect({ to: '/' });
      }
      throw error;
    }
  },
  component: GuildPicker,
});

/** Only guilds the signed-in user actually administers are ever listed (I6). */
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
