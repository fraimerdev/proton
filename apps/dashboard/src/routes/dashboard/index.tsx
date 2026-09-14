import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { ProtonMark, UserMenu } from '../../components/shell/topbar.tsx';
import { cx, SearchField } from '../../components/ui/controls.tsx';
import { EmptyState, StatusBanner } from '../../components/ui/feedback.tsx';
import { isAccessError } from '../../lib/errors.ts';
import { guildIconUrl, type SessionGuild } from '../../lib/guild-access.ts';
import { botInviteUrl } from '../../lib/invite.ts';
import { sessionQuery } from '../../lib/queries.ts';
import { signOut } from '../../server/session.ts';

export const Route = createFileRoute('/dashboard/')({
  loader: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery(sessionQuery());
    } catch (error) {
      if (isAccessError(error))
        throw redirect({ to: '/signin', search: { redirect: '/dashboard' } });
      throw error;
    }
  },
  component: ServerPicker,
});

function acronym(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => [...word][0] ?? '');

  return initials.slice(0, 3).join('') || '?';
}

function ServerCard({
  guild,
  absent,
  inviteHref,
}: {
  guild: SessionGuild;
  absent: boolean;
  inviteHref: string | null;
}): ReactElement {
  const icon = guildIconUrl(guild, 256);

  return (
    <li className={cx('server-card', absent && 'absent')}>
      <div className="server-card-art" aria-hidden>
        {icon ? (
          <>
            <img src={icon} alt="" className="server-card-backdrop" />
            <img src={icon} alt="" width={64} height={64} className="server-card-icon" />
          </>
        ) : (
          <>
            <span className="server-card-glow" />
            <span className="server-card-icon server-card-acronym">{acronym(guild.name)}</span>
          </>
        )}
      </div>

      <div className="server-card-foot">
        <span className="server-card-name">{guild.name}</span>

        {!absent ? (
          <Link
            to="/dashboard/$guildId"
            params={{ guildId: guild.id }}
            className="button button-primary button-sm server-card-action"
            aria-label={`Manage ${guild.name}`}
          >
            Manage
          </Link>
        ) : inviteHref ? (
          <a
            href={inviteHref}
            className="button button-secondary button-sm server-card-action"
            aria-label={`Add Proton to ${guild.name}`}
          >
            Add Proton
          </a>
        ) : (
          <span className="server-card-status">Not added</span>
        )}
      </div>
    </li>
  );
}

function ServerPicker(): ReactElement {
  const { guilds, presenceKnown, invite, user } = useSuspenseQuery(sessionQuery()).data;
  const [query, setQuery] = useState('');
  const router = useRouter();

  const needle = query.trim().toLowerCase();
  const shown = guilds.filter((guild) => guild.name.toLowerCase().includes(needle));

  return (
    <div className="site">
      <header className="site-header site-header-contained">
        <div className="shell-container site-header-inner">
          <Link to="/" className="topbar-brand">
            <ProtonMark />
            Proton
          </Link>
          <span className="topbar-spacer" />
          <UserMenu
            viewer={{ id: user.id, name: user.name, image: user.image }}
            onSignOut={() => {
              void signOut().then(() => router.navigate({ to: '/', reloadDocument: true }));
            }}
          />
        </div>
      </header>

      <main className="site-main">
        <div className="server-picker">
          <h1 className="server-picker-title">Choose a server</h1>
          <p className="server-picker-lede">
            Only servers you own or have Manage Server in are listed.
          </p>

          {!presenceKnown ? (
            <div className="server-picker-notice">
              <StatusBanner tone="warning" title="Proton could not check which servers it is in">
                Every server you manage shows Manage, including any Proton has not joined, until it
                can reach Discord again.
              </StatusBanner>
            </div>
          ) : null}

          {guilds.length > 8 ? (
            <div className="server-picker-search">
              <SearchField
                value={query}
                onChange={setQuery}
                placeholder="Search servers…"
                label="Search servers"
              />
            </div>
          ) : null}

          {guilds.length === 0 ? (
            <EmptyState icon="users-three" title="No servers to manage" inset>
              If you were just given Manage Server, sign out and back in.
            </EmptyState>
          ) : null}

          {shown.length > 0 ? (
            <ul className="server-grid">
              {shown.map((guild) => (
                <ServerCard
                  key={guild.id}
                  guild={guild}
                  absent={presenceKnown && !guild.present}
                  inviteHref={invite ? botInviteUrl(invite, guild.id) : null}
                />
              ))}
            </ul>
          ) : null}

          {shown.length === 0 && guilds.length > 0 ? (
            <EmptyState icon="magnifying-glass" title="No matching servers" inset />
          ) : null}
        </div>
      </main>
    </div>
  );
}
