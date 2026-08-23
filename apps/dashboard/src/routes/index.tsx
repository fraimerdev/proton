import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { ProtonMark } from '../components/shell/app-shell.tsx';
import { Icon } from '../components/shell/icon.tsx';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home(): ReactElement {
  return (
    <div className="door">
      <div className="door-inner">
        <div className="door-mark">
          <ProtonMark size={30} />
          <span className="door-wordmark">Proton</span>
        </div>

        <div className="door-copy">
          <h1 className="door-title">Moderation your team can audit.</h1>
          <p className="door-sub">
            Every action Proton takes becomes a numbered case with the moderator, the reason and the
            time. Configure it here; run it from Discord.
          </p>
        </div>

        <ul className="door-facts">
          <li>
            <b>Moderation</b>
            Bans, kicks, timeouts and purges, each recorded as a case you can search and reverse.
          </li>
          <li>
            <b>Security</b>
            Discord’s own AutoMod for what it can block at the edge; Proton for the rest.
          </li>
          <li>
            <b>Engagement</b>
            Levels, role menus, tickets and scheduled messages.
          </li>
        </ul>

        <a className="button button-discord door-button" href="/api/auth/signin/discord">
          <Icon name="discord-logo" weight="fill" />
          Continue with Discord
        </a>

        <p className="door-fineprint">
          Proton stores moderation cases, server settings and — only where a server admin switches
          it on — message edit and deletion logs.
        </p>

        <div className="door-links">
          <Link to="/dashboard" className="door-link">
            Your servers
          </Link>
          <Link to="/privacy" className="door-link">
            Privacy policy
          </Link>
        </div>
      </div>

      <div className="door-art" aria-hidden="true">
        <img src="/proton-mark.png" alt="" decoding="async" />
      </div>
    </div>
  );
}
