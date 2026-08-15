import { createFileRoute, Link } from '@tanstack/react-router';
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
        <Link to="/guilds">Your servers</Link>
      </p>

      <p className="field-description">
        Proton stores moderation cases, server settings and — only where a server admin switches it
        on — message edit and deletion logs. <Link to="/privacy">What Proton stores</Link>.
      </p>
    </section>
  );
}
