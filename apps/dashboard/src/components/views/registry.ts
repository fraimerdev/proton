import {
  type CaseSearchResult,
  caseQuerySchema,
  type LeaderboardResult,
  leaderboardQuerySchema,
} from '@proton/core';
import { type TagSearchResult, tagQuerySchema } from '@proton/module-tags/query';
import type { QueryFunction, UseSuspenseQueryOptions } from '@tanstack/react-query';
import { lazyRouteComponent } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import { z } from 'zod';
import { LIVE, queryKeys, STALE } from '../../lib/query-keys.ts';

export interface ViewProps<TSchema extends z.ZodType, TData> {
  search: z.output<TSchema>;
  data: TData;
  onSearch: (patch: Partial<z.input<TSchema>>) => void;
}

export type ViewQuery<TData> = Omit<
  UseSuspenseQueryOptions<TData, Error, TData, readonly unknown[]>,
  'queryFn'
> & { queryFn: QueryFunction<TData, readonly unknown[]> };

export interface ViewEntry<TSchema extends z.ZodType, TData> {
  id: string;
  title: string;
  searchSchema: TSchema;
  query: (args: { guildId: string; search: z.output<TSchema> }) => ViewQuery<TData>;

  // Lazy, and preloaded by the module loader: views.tsx drags react-table and react-virtual in, and
  // registry.ts is pinned into the eager half of the route by validateSearch — so a static import
  // here ships the table libraries to anyone who opens the signed-out landing page.
  View: ComponentType<ViewProps<TSchema, TData>> & {
    preload?: (() => Promise<void> | undefined) | undefined;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: an entry is invariant in its own search and result types, so a registry holding several can only erase them
export type AnyViewEntry = ViewEntry<any, any>;

export type CaseBrowserProps = ViewProps<typeof caseQuerySchema, CaseSearchResult>;
export type LeaderboardProps = ViewProps<typeof leaderboardQuerySchema, LeaderboardResult>;
export type TagBrowserProps = ViewProps<typeof tagQuerySchema, TagSearchResult>;

export const MODULE_VIEWS: Readonly<Record<string, readonly AnyViewEntry[]>> = {
  cases: [
    {
      id: 'cases',
      title: 'Cases',
      searchSchema: caseQuerySchema,

      query: ({ guildId, search }) => ({
        queryKey: queryKeys.view(guildId, 'cases', search),

        // Imported lazily: server/modules.ts opens better-auth's database at module scope.
        queryFn: async () =>
          (await import('../../server/modules.ts')).searchCases({ data: { guildId, ...search } }),
        staleTime: STALE.browse,
        ...LIVE,
      }),
      View: lazyRouteComponent(() => import('./views.tsx'), 'CaseBrowserView'),
    } satisfies ViewEntry<typeof caseQuerySchema, CaseSearchResult>,
  ],
  tags: [
    {
      id: 'tags',
      title: 'Tags',
      searchSchema: tagQuerySchema,

      query: ({ guildId, search }) => ({
        queryKey: queryKeys.view(guildId, 'tags', search),
        queryFn: async () =>
          (await import('../../server/modules.ts')).searchTags({ data: { guildId, ...search } }),
        staleTime: STALE.browse,
        ...LIVE,
      }),
      View: lazyRouteComponent(() => import('./views.tsx'), 'TagBrowserView'),
    } satisfies ViewEntry<typeof tagQuerySchema, TagSearchResult>,
  ],
  leveling: [
    {
      id: 'leaderboard',
      title: 'Leaderboard',
      searchSchema: leaderboardQuerySchema,
      query: ({ guildId, search }) => ({
        queryKey: queryKeys.view(guildId, 'leaderboard', search),
        queryFn: async () =>
          (await import('../../server/modules.ts')).searchLeaderboard({
            data: { guildId, ...search },
          }),
        staleTime: STALE.browse,
        ...LIVE,
      }),
      View: lazyRouteComponent(() => import('./views.tsx'), 'LeaderboardView'),
    } satisfies ViewEntry<typeof leaderboardQuerySchema, LeaderboardResult>,
  ],
};

export const SETTINGS_TAB = 'settings';

// Loose, because the active view's own filters ride in the same query string and a strict object
// would strip them before the loader could re-parse them with the view's real schema. `view` is
// unknown rather than a string so that `?view=1` reaches resolveView's sentence instead of dying
// here as a raw Zod issue dump.
export const moduleSearchSchema = z.looseObject({
  view: z.unknown().optional(),
  area: z.unknown().optional(),
});

export type ModuleSearch = z.infer<typeof moduleSearchSchema>;

// Object.hasOwn, not a lookup-and-test: MODULE_VIEWS['constructor'] would otherwise be truthy.
export function viewsFor(moduleId: string): readonly AnyViewEntry[] {
  return Object.hasOwn(MODULE_VIEWS, moduleId) ? (MODULE_VIEWS[moduleId] ?? []) : [];
}

export function activeView(moduleId: string, view: unknown): AnyViewEntry | undefined {
  return viewsFor(moduleId).find((entry) => entry.id === view);
}

export function resolveView(moduleId: string, view: unknown): AnyViewEntry | undefined {
  if (view === undefined) return undefined;

  const entry = activeView(moduleId, view);
  if (entry) return entry;

  const known = viewsFor(moduleId).map((candidate) => `'${candidate.id}'`);

  throw new Error(
    `The '${moduleId}' module has no '${String(view)}' tab — ${
      known.length > 0 ? `it has ${known.join(', ')}` : 'it has settings only'
    }. Remove the view parameter from the address bar to open its settings.`,
  );
}

export interface TabDescriptor {
  key: string;
  title: string;
  search: ModuleSearch;
  current: boolean;
}

// The settings tab is the absence of ?view=, not the id 'settings', which a view may legally own.
export function tabsFor(views: readonly AnyViewEntry[], view: unknown): readonly TabDescriptor[] {
  if (views.length === 0) return [];

  const active = views.find((entry) => entry.id === view);

  return [
    { key: SETTINGS_TAB, title: 'Settings', search: {}, current: active === undefined },
    ...views.map((entry) => ({
      key: `view:${entry.id}`,
      title: entry.title,
      search: { view: entry.id },
      current: entry === active,
    })),
  ];
}

function valueAt(search: unknown, path: readonly PropertyKey[]): unknown {
  let value = search;

  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

// Explained, not coerced: the number arrives already rounded, so accepting it searches for nobody.
function unquotedId(search: unknown, issue: z.core.$ZodIssue): boolean {
  return (
    issue.code === 'invalid_type' &&
    issue.expected === 'string' &&
    typeof valueAt(search, issue.path) === 'number'
  );
}

export function parseViewSearch(entry: AnyViewEntry, search: unknown): unknown {
  const schema: z.ZodType = entry.searchSchema;

  const parsed = schema.safeParse(search);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'the query string'}: ${issue.message}`)
    .join('; ');

  const unquoted = parsed.error.issues
    .filter((issue) => unquotedId(search, issue))
    .map((issue) => issue.path.join('.'));

  const hint =
    unquoted.length > 0
      ? ` A Discord id has to be quoted in the address bar — ${unquoted.join(' and ')}="2000…" — ` +
        'because an unquoted one is read as a number and loses its last digits.'
      : '';

  throw new Error(
    `These ${entry.title} filters are not valid — ${detail}.${hint} ` +
      'Remove the query string from the address bar to start from an unfiltered list.',
  );
}

export function viewSearchUpdate(patch: ModuleSearch): {
  search: (prev: ModuleSearch) => ModuleSearch;
  replace: boolean;
} {
  // replace, not push: Back leaves the module page rather than stepping through every page and
  // filter the reader tried.
  return { search: (prev) => ({ ...prev, ...patch }), replace: true };
}
