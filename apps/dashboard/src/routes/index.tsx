import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home(): ReactElement {
  return (
    <section className="panel">
      <h1>Proton dashboard</h1>
      <p>Sign in with Discord to configure the servers you administer.</p>
      <a className="button" href="/api/auth/signin/discord">
        Sign in with Discord
      </a>
      <p>
        <a href="/guilds">Your servers</a>
      </p>
    </section>
  );
}
