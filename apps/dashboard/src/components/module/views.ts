import type { QueryFunction, UseSuspenseQueryOptions } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { ModuleSearch } from './route.tsx';

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

  // Lazy, and preloaded by the loader: a browse table drags react-table and react-virtual in, and
  // a static import would ship them to anyone who only opened the module's settings.
  View: ComponentType<ViewProps<TSchema, TData>> & {
    preload?: (() => Promise<void> | undefined) | undefined;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: an entry is invariant in its own search and result types, so a list holding several can only erase them
export type ModuleView = ViewEntry<any, any>;

export function resolveView(
  moduleId: string,
  views: readonly ModuleView[],
  view: unknown,
): ModuleView | undefined {
  if (view === undefined) return undefined;

  const entry = views.find((candidate) => candidate.id === view);
  if (entry) return entry;

  const known = views.map((candidate) => `'${candidate.id}'`);

  throw new Error(
    `The '${moduleId}' module has no '${String(view)}' tab — ${
      known.length > 0 ? `it has ${known.join(', ')}` : 'it has settings only'
    }. Remove the view parameter from the address bar to open its settings.`,
  );
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

export function parseViewSearch(entry: ModuleView, search: unknown): unknown {
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
