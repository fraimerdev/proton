import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { listGuilds } from '../server/modules.ts';

export const Route = createFileRoute('/guilds/')({
  loader: () => listGuilds(),
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
            <Link
              to="/guilds/$guildId/modules/$moduleId"
              params={{ guildId: guild.id, moduleId: 'ping' }}
            >
              {guild.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
