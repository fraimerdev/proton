import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { CatchBoundary, Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ComponentProps, type ReactElement, Suspense, useCallback } from 'react';
import { z } from 'zod';
import { readFailure } from '../../lib/errors.ts';
import { areaMeta, MODULE_BY_ID, type ModuleMeta } from '../../lib/modules/catalogue.ts';
import { moduleConfigQuery, modulesQuery } from '../../lib/queries.ts';
import { Workspace } from '../shell/app-shell.tsx';
import { Button } from '../ui/controls.tsx';
import { StatusBanner } from '../ui/feedback.tsx';
import { ModuleHeader } from './page.tsx';
import { ModuleLoading } from './pending.tsx';
import type { ModulePageProps } from './registry.ts';

export const moduleSearchSchema = z.object({
  area: z.string().optional(),
  id: z.string().optional(),
  q: z.string().optional(),
  page: z.number().int().min(1).optional(),
  status: z.string().optional(),
  sort: z.string().optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export type ModuleSearch = z.infer<typeof moduleSearchSchema>;

// strict:false: the page is mounted under a different route file for every module.
export function useModuleSearch(): ModuleSearch {
  return useSearch({ strict: false }) as ModuleSearch;
}

export function useGuildId(): string {
  return (useParams({ strict: false }) as { guildId?: string }).guildId ?? '';
}

type LinkProps = ComponentProps<typeof Link>;

export function ModuleLink({
  guildId,
  moduleId,
  search,
  children,
  ...rest
}: {
  guildId: string;
  moduleId: string;
  search?: ModuleSearch | undefined;
} & Omit<LinkProps, 'to' | 'params' | 'search'>): ReactElement {
  // One cast: `to` is a union of every module route, all with the same params and search.
  const props = {
    to: `/dashboard/$guildId/${moduleId}`,
    params: { guildId },
    search: search ?? {},
    ...rest,
  } as unknown as LinkProps;

  return <Link {...props}>{children}</Link>;
}

export function useModuleNavigate(
  guildId: string,
  moduleId: string,
): (patch: ModuleSearch, options?: { replace?: boolean | undefined }) => void {
  const navigate = useNavigate();

  return useCallback(
    (patch: ModuleSearch, options?: { replace?: boolean | undefined }) => {
      void navigate({
        to: `/dashboard/$guildId/${moduleId}`,
        params: { guildId },
        search: (previous: ModuleSearch) => ({ ...previous, ...patch }),
        replace: options?.replace ?? false,
        resetScroll: false,
        // The same cast as ModuleLink: every module route takes one shape.
      } as unknown as Parameters<ReturnType<typeof useNavigate>>[0]);
    },
    [navigate, guildId, moduleId],
  );
}

function ModuleFailure({
  meta,
  error,
  onRetry,
  retrying = false,
}: {
  meta: ModuleMeta;
  error: unknown;
  onRetry: () => void;
  retrying?: boolean | undefined;
}): ReactElement {
  return (
    <>
      <ModuleHeader meta={meta} />
      <StatusBanner
        tone="danger"
        live="polite"
        actions={
          <Button tone="secondary" size="sm" busy={retrying} onClick={onRetry}>
            Try again
          </Button>
        }
      >
        {readFailure(error, `${meta.label} settings`)}
      </StatusBanner>
    </>
  );
}

export function ModuleRoute({
  moduleId,
  page: Page,
}: {
  moduleId: string;
  page: (props: ModulePageProps) => ReactElement;
}): ReactElement | null {
  const guildId = useGuildId();
  const { area } = useModuleSearch();
  const { modules } = useSuspenseQuery(modulesQuery(guildId)).data;
  // Not useSuspenseQuery: React holds a Suspense reveal 300ms, so a fast config would flash.
  const config = useQuery(moduleConfigQuery(guildId, moduleId));

  const meta = MODULE_BY_ID.get(moduleId) as ModuleMeta | undefined;
  if (!meta) return null;

  const resolved = areaMeta(meta, area)?.id ?? '';
  const summary = modules.find((candidate) => candidate.id === moduleId);

  return (
    <Workspace>
      {config.data === undefined && config.isError ? (
        <ModuleFailure
          meta={meta}
          error={config.error}
          retrying={config.isFetching}
          onRetry={() => void config.refetch()}
        />
      ) : config.data === undefined ? (
        <ModuleLoading guildId={guildId} meta={meta} summary={summary} area={resolved} />
      ) : (
        <CatchBoundary
          getResetKey={() => `${moduleId}:${resolved}`}
          errorComponent={({ error, reset }) => (
            <ModuleFailure meta={meta} error={error} onRetry={reset} />
          )}
        >
          <Suspense
            fallback={
              <ModuleLoading
                guildId={guildId}
                meta={meta}
                summary={summary}
                area={resolved}
                fallback
              />
            }
          >
            <Page guildId={guildId} meta={meta} summary={summary} area={resolved} />
          </Suspense>
        </CatchBoundary>
      )}
    </Workspace>
  );
}
