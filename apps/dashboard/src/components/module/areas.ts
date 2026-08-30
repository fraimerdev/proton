import type { IconName } from '../shell/icon-set.gen.ts';

export interface AreaEntry {
  id: string;
  title: string;
  blurb: string;
  icon: IconName;

  count?: (config: Record<string, unknown>) => string | null;
}

export function tally(config: Record<string, unknown>, key: string, noun: string): string | null {
  const held = config[key];
  const length = Array.isArray(held) ? held.length : 0;

  return length === 0 ? null : `${length} ${noun}${length === 1 ? '' : 's'}`;
}

export function activeArea(areas: readonly AreaEntry[], area: unknown): AreaEntry | undefined {
  return areas.find((entry) => entry.id === area);
}

export function resolveArea(
  moduleId: string,
  areas: readonly AreaEntry[],
  area: unknown,
): AreaEntry | undefined {
  if (area === undefined) return undefined;

  const entry = activeArea(areas, area);
  if (entry) return entry;

  const known = areas.map((candidate) => `'${candidate.id}'`);

  throw new Error(
    `The '${moduleId}' module has no '${String(area)}' area — ${
      known.length > 0 ? `it has ${known.join(', ')}` : 'its settings are one page'
    }. Remove the area parameter from the address bar to open it.`,
  );
}
