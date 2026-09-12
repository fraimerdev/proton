import type { IconName } from '../shell/icon-set.gen.ts';

/**
 * How much of a thing an area holds. Two forms because it is read in two places: `short` sits on the
 * tab, which has already named the thing ("Bait channels 3"), and `long` names it itself for the one
 * operational line in the module's head ("3 bait channels").
 */
export interface AreaCount {
  short: string;
  long: string;
}

export interface AreaEntry {
  id: string;
  title: string;
  blurb: string;
  icon: IconName;

  count?: (config: Record<string, unknown>) => AreaCount | null;
}

export function tally(
  config: Record<string, unknown>,
  key: string,
  noun: string,
): AreaCount | null {
  const held = config[key];
  const length = Array.isArray(held) ? held.length : 0;

  return length === 0
    ? null
    : { short: `${length}`, long: `${length} ${noun}${length === 1 ? '' : 's'}` };
}

export function areaCount(
  area: AreaEntry,
  config: Record<string, unknown> | undefined,
): AreaCount | null {
  return area.count === undefined || config === undefined ? null : area.count(config);
}

// Falls back to the first area rather than to nothing. A module with areas used to open on a menu
// of them — a page whose entire content was links to the settings the admin had already asked for.
export function activeArea(areas: readonly AreaEntry[], area: unknown): AreaEntry | undefined {
  return areas.find((entry) => entry.id === area) ?? areas[0];
}

export function resolveArea(
  moduleId: string,
  areas: readonly AreaEntry[],
  area: unknown,
): AreaEntry | undefined {
  if (area === undefined) return areas[0];

  const entry = areas.find((candidate) => candidate.id === area);
  if (entry) return entry;

  const known = areas.map((candidate) => `'${candidate.id}'`);

  throw new Error(
    `The '${moduleId}' module has no '${String(area)}' area — ${
      known.length > 0 ? `it has ${known.join(', ')}` : 'its settings are one page'
    }. Remove the area parameter from the address bar to open it.`,
  );
}
