import { createFileRoute, Link } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { ProtonMark } from '../components/shell/app-shell.tsx';
import { Icon } from '../components/shell/icon.tsx';

// Better Auth redirects a failed OAuth callback back here with these two, and until it had a route
// to land on the whole failure was a not-found page.
const doorSearchSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const SIGN_IN_FAILURES: Record<string, string> = {
  access_denied: 'Discord did not grant Proton access, so nothing was shared.',
  no_code: 'Discord did not complete the sign-in.',
  invalid_code: 'Discord did not complete the sign-in.',
  unable_to_get_user_info: 'Discord accepted the sign-in but would not return your account.',
  no_callback_url: 'Proton could not work out where to send you back to.',
};

export function signInFailure(code: string, description?: string): string {
  return SIGN_IN_FAILURES[code] ?? description ?? `Discord returned “${code}”.`;
}

export const Route = createFileRoute('/')({
  validateSearch: zodValidator(doorSearchSchema),
  component: Home,
});

function Home(): ReactElement {
  const { error, error_description: description } = Route.useSearch();

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

        {error ? (
          <div className="alert-banner" role="alert">
            <Icon name="warning-circle" weight="fill" />
            <span className="alert-banner-text">
              {signInFailure(error, description)} You are not signed in.
            </span>
          </div>
        ) : null}

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
