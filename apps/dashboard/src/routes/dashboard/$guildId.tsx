import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, redirect, useRouter } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useGuildId } from '../../components/module/route.tsx';
import { DashboardShell, Workspace } from '../../components/shell/app-shell.tsx';
import { Button } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { RoutePending } from '../../components/ui/pending.tsx';
import { failureKind, isAccessError } from '../../lib/errors.ts';
import { warmGuildShape } from '../../lib/modules/preload.ts';
import { modulesQuery, sessionQuery } from '../../lib/queries.ts';
import { signOut } from '../../server/session.ts';

export const Route = createFileRoute('/dashboard/$guildId')({
  loader: async ({ context, params, location }) => {
    // fetchQuery, not ensureQueryData: a cached session would keep a revoked admin past the redirect.
    try {
      const session = await context.queryClient.fetchQuery(sessionQuery());
      const guild = session.guilds.find((candidate) => candidate.id === params.guildId);

      // Before the modules load: for a server Proton has left, the api answers with an empty list, not an error.
      if (session.presenceKnown && guild && !guild.present) {
        throw new Error(
          `Proton isn’t in ${guild.name} yet. Add it to the server, then open this page again.`,
        );
      }

      await context.queryClient.fetchQuery(modulesQuery(params.guildId));

      // Fired, not awaited: every module page's pickers want these and they are the same for all
      // of them, so one request per server beats one per picker.
      warmGuildShape(context.queryClient, params.guildId);
    } catch (error) {
      // Not /dashboard: its server list is cached for 30 seconds and would show the picker again.
      if (failureKind(error) === 'signed-out')
        throw redirect({ to: '/signin', search: { redirect: location.href } });
      if (isAccessError(error)) throw redirect({ to: '/dashboard' });

      throw error;
    }
  },
  // 0, not 1000 and 500: switching servers keeps the topbar and sidebar on screen at once.
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: ShellPending,
  component: GuildShell,
  errorComponent: ShellError,
  notFoundComponent: GuildNotFound,
});

function useSignOut(): () => void {
  const router = useRouter();

  return () => {
    void signOut().then(() => router.navigate({ to: '/', reloadDocument: true }));
  };
}

function GuildShell(): ReactElement {
  const { guildId } = Route.useParams();
  const { guilds, user, presenceKnown } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;
  const onSignOut = useSignOut();

  return (
    <DashboardShell
      guildId={guildId}
      guilds={guilds}
      presenceKnown={presenceKnown}
      viewer={{ id: user.id, name: user.name, image: user.image }}
      modules={modules}
      onSignOut={onSignOut}
    >
      <Outlet />
    </DashboardShell>
  );
}

function ShellPending(): ReactElement {
  const guildId = useGuildId();
  const session = useQuery(sessionQuery());
  const modules = useQuery(modulesQuery(guildId));
  const onSignOut = useSignOut();

  if (session.data === undefined) return <RoutePending />;

  const { guilds, user, presenceKnown } = session.data;

  return (
    <DashboardShell
      guildId={guildId}
      guilds={guilds}
      presenceKnown={presenceKnown}
      viewer={{ id: user.id, name: user.name, image: user.image }}
      modules={modules.data?.modules ?? []}
      onSignOut={onSignOut}
    >
      <RoutePending />
    </DashboardShell>
  );
}

function ShellError({ error }: { error: Error }): ReactElement {
  return (
    <main className="workspace shell-container">
      <Workspace>
        <header className="page-head">
          <div className="page-head-main">
            <h1 className="page-title">Couldn’t open this server</h1>
          </div>
        </header>

        <StatusBanner
          tone="danger"
          actions={
            <Link to="/dashboard" className="button button-secondary button-sm">
              Back to your servers
            </Link>
          }
        >
          {error.message}
        </StatusBanner>

        <div className="stack stack-8" style={{ marginTop: 16 }}>
          <Button tone="ghost" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      </Workspace>
    </main>
  );
}

function GuildNotFound(): ReactElement {
  return (
    <Workspace>
      <header className="page-head">
        <div className="page-head-main">
          <h1 className="page-title">Page not found</h1>
          <p className="page-subtitle">There’s no page at this address.</p>
        </div>
      </header>
    </Workspace>
  );
}
