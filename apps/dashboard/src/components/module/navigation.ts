export function searchKey(location: { search: unknown }, key: string): unknown {
  const search = location.search;

  return typeof search === 'object' && search !== null
    ? (search as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Whether the settings form is still on screen after the move, and so still holding its edits.
 * Two areas of one module keep it mounted; leaving the last area for the hub does not, because
 * the hub replaces the whole subtree — and that discard used to happen with no confirmation at all.
 */
export function settingsSurvives(
  current: { pathname: string; search: unknown },
  next: { pathname: string; search: unknown },
  hasAreas: boolean,
): boolean {
  if (current.pathname !== next.pathname) return false;
  if (searchKey(current, 'view') !== searchKey(next, 'view')) return false;
  if (!hasAreas) return true;

  return searchKey(current, 'area') !== undefined && searchKey(next, 'area') !== undefined;
}
