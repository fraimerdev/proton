import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, redirect, useRouter } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useGuildId } from '../../components/module/route.tsx';
import { DashboardShell, Workspace } from '../../components/shell/app-shell.tsx';
import { Button } from '../../components/ui/controls.tsx';
import { StatusBanner } from '../../components/ui/feedback.tsx';
import { RoutePending } from '../../components/ui/pending.tsx';
import { isAccessError } from '../../lib/errors.ts';
import { warmGuildShape } from '../../lib/modules/preload.ts';
import { modulesQuery, sessionQuery } from '../../lib/queries.ts';
import { signOut } from '../../server/session.ts';

export const Route = createFileRoute('/dashboard/$guildId')({
  loader: async ({ context, params }) => {
    // fetchQuery, not ensureQueryData: ensureQueryData resolves from the cache at any age and
    // revalidates through prefetchQuery, which swallows the rejection — so a revoked admin would
    // keep rendering the shell instead of reaching the redirect below.
    try {
      const session = await context.queryClient.fetchQuery(sessionQuery());
      const guild = session.guilds.find((candidate) => candidate.id === params.guildId);

      // Ahead of the modules load rather than in its catch: for a server Proton has left the api
      // answers with an empty module list instead of an error, so this shell would otherwise
      // render intact and every switch on it would save into a guild nothing is listening in.
      // Only a checked absence blocks — an unreachable presence lookup must not close the page.
      if (session.presenceKnown && guild && !guild.present) {
        throw new Error(
          `Proton is not in ${guild.name}, so there is nothing to configure yet. Invite it to that server and open this page again.`,
        );
      }

      await context.queryClient.fetchQuery(modulesQuery(params.guildId));

      // Fired, not awaited: every module page's pickers want these and they are the same for all
      // of them, so one request per server beats one per picker.
      warmGuildShape(context.queryClient, params.guildId);
    } catch (error) {
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
            <h1 className="page-title">Server not loaded</h1>
          </div>
        </header>

        <StatusBanner
          tone="danger"
          title="Proton could not open this server"
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
