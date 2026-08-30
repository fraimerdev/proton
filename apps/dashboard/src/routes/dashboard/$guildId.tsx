import type { ModuleSummary } from '@proton/core';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '../../components/shell/app-shell.tsx';
import { Icon } from '../../components/shell/icon.tsx';
import { ModuleToggleProvider } from '../../components/shell/module-toggle.tsx';

import { isAccessError, saveFailure } from '../../lib/errors.ts';
import { modulesQuery, sessionQuery } from '../../lib/queries.ts';
import { queryKeys } from '../../lib/query-keys.ts';
import { updateModuleConfig } from '../../server/modules.ts';

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
      if (session.presenceKnown && guild && !guild.present)
        throw new Error(
          `Proton is not in ${guild.name}, so there is nothing to configure yet. Invite it to that server and open this page again.`,
        );

      await context.queryClient.fetchQuery(modulesQuery(params.guildId));
    } catch (error) {
      if (isAccessError(error)) throw redirect({ to: '/dashboard' });

      throw error;
    }
  },
  component: GuildShell,
  errorComponent: ShellError,
});

function flip(
  index: { modules: ModuleSummary[] } | undefined,
  moduleId: string,
  enabled: boolean,
): { modules: ModuleSummary[] } | undefined {
  return (
    index && {
      ...index,
      modules: index.modules.map((module) =>
        module.id === moduleId ? { ...module, enabled } : module,
      ),
    }
  );
}

function GuildShell(): ReactElement {
  const { guildId } = Route.useParams();
  const { guilds, user, presenceKnown } = useSuspenseQuery(sessionQuery()).data;
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;

  const queryClient = useQueryClient();
  const modulesKey = modulesQuery(guildId).queryKey;

  // Held here rather than read off toggle.error: one useMutation backs every module in the
  // sidebar, and its observer only ever reports the newest call — so a slow switch that fails
  // after a later one succeeded would flip back with no banner naming what went wrong.
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: ({ module, enabled }: { module: ModuleSummary; enabled: boolean }) =>
      updateModuleConfig({ data: { guildId, moduleId: module.id, enabled } }),

    onMutate: async ({ module, enabled }) => {
      setFailure(null);
      await queryClient.cancelQueries({ queryKey: modulesKey });
      queryClient.setQueryData(modulesKey, (current) => flip(current, module.id, enabled));
    },

    // Flipped back one module at a time rather than restored from a snapshot: a second switch
    // thrown while this one was in flight has already written its own optimistic value here.
    onError: (error, { module, enabled }) => {
      queryClient.setQueryData(modulesKey, (current) => flip(current, module.id, !enabled));
      setFailure(saveFailure(error, `${module.name} was not switched ${enabled ? 'on' : 'off'}`));
    },

    onSettled: (_data, _error, { module }) => {
      void queryClient.invalidateQueries({ queryKey: modulesKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.moduleConfig(guildId, module.id) });
    },
  });

  const onToggleModule = useCallback(
    (module: ModuleSummary, enabled: boolean) => toggle.mutate({ module, enabled }),
    [toggle.mutate],
  );

  const banner = useRef<HTMLDivElement>(null);

  // The banner sits above the module list and the switch that failed may be twenty rows down it,
  // so the explanation for a switch flipping back was routinely off the top of the viewport.
  useEffect(() => {
    if (failure) banner.current?.scrollIntoView({ block: 'nearest' });
  }, [failure]);

  // The banner names one module by name, so carrying it onto the next module's page reads as that
  // module having failed. Moving on is the dismissal.
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation is the trigger, not an input
  useEffect(() => {
    setFailure(null);
  }, [pathname]);

  return (
    <ModuleToggleProvider value={onToggleModule}>
      <AppShell
        guildId={guildId}
        guilds={guilds}
        presenceKnown={presenceKnown}
        user={user}
        modules={modules}
      >
        <div aria-live="assertive" ref={banner}>
          {failure ? (
            <div className="alert-banner">
              <Icon name="warning-circle" weight="fill" />
              <span className="alert-banner-text">{failure}</span>
            </div>
          ) : null}
        </div>

        <Outlet />
      </AppShell>
    </ModuleToggleProvider>
  );
}

function ShellError({ error }: { error: Error }): ReactElement {
  return (
    <main className="main">
      <div className="page">
        <div className="page-head">
          <div className="page-heading">
            <h1 className="page-title">This server did not load</h1>
          </div>
        </div>
        <div className="gap-card">
          <div className="gap-body">
            <span className="gap-head">
              <Icon name="warning-circle" weight="fill" className="state-blocked" />
              <span className="gap-name">Proton could not open this server</span>
            </span>
            <p className="gap-text" role="alert">
              {error.message}
            </p>
          </div>
          <Link to="/dashboard" className="button button-quiet">
            Back to your servers
          </Link>
        </div>
      </div>
    </main>
  );
}
