import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ComponentProps, type ReactElement, Suspense, useCallback } from 'react';
import { z } from 'zod';
import { areaMeta, MODULE_BY_ID, type ModuleMeta } from '../../lib/modules/catalogue.ts';
import { moduleConfigQuery, modulesQuery } from '../../lib/queries.ts';
import { Workspace } from '../shell/app-shell.tsx';
import { ModuleLoading } from './pending.tsx';
import type { ModulePageProps } from './registry.ts';

/**
 * The search params every module route accepts. A module whose page needs more of them declares its
 * own schema by extending this one in its route file.
 */
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

// strict:false, because these read the route the page happens to be mounted under, and that is a
// different route file for every module.
export function useModuleSearch(): ModuleSearch {
  return useSearch({ strict: false }) as ModuleSearch;
}

export function useGuildId(): string {
  return (useParams({ strict: false }) as { guildId?: string }).guildId ?? '';
}

type LinkProps = ComponentProps<typeof Link>;

/**
 * A link to a module's own route. Every module has one, so the path is built from the id rather
 * than routed through a single dynamic segment.
 */
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
  // One cast, here: `to` is a union of thirty sibling routes that all take the same params and the
  // same search shape, and spelling that union out at every call site buys nothing.
  const props = {
    to: `/dashboard/$guildId/${moduleId}`,
    params: { guildId },
    search: search ?? {},
    ...rest,
  } as unknown as LinkProps;

  return <Link {...props}>{children}</Link>;
}

/** Patches the current module route's search params, keeping the ones it does not name. */
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
        // Same reason as ModuleLink: thirty sibling routes, one shape.
      } as unknown as Parameters<ReturnType<typeof useNavigate>>[0]);
    },
    [navigate, guildId, moduleId],
  );
}

export function moduleHref(guildId: string, moduleId: string): string {
  return `/dashboard/${guildId}/${moduleId}`;
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
  // A function, not true: a failed background refetch keeps the settings already on screen.
  const config = useQuery({
    ...moduleConfigQuery(guildId, moduleId),
    throwOnError: (_error, query) => query.state.data === undefined,
  });

  const meta = MODULE_BY_ID.get(moduleId) as ModuleMeta | undefined;
  if (!meta) return null;

  const resolved = areaMeta(meta, area)?.id ?? '';
  const summary = modules.find((candidate) => candidate.id === moduleId);

  return (
    <Workspace>
      {config.data === undefined ? (
        <ModuleLoading guildId={guildId} meta={meta} summary={summary} area={resolved} />
      ) : (
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
      )}
    </Workspace>
  );
}
