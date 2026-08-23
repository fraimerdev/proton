import type { IconName } from '../shell/icon-set.gen.ts';

export interface AreaEntry {
  id: string;
  title: string;
  blurb: string;
  icon: IconName;

  sections?: readonly string[];
  panels?: readonly string[];

  count?: (config: Record<string, unknown>) => string | null;
}

function tally(config: Record<string, unknown>, key: string, noun: string): string | null {
  const held = config[key];
  const length = Array.isArray(held) ? held.length : 0;

  return length === 0 ? null : `${length} ${noun}${length === 1 ? '' : 's'}`;
}

export const MODULE_AREAS: Readonly<Record<string, readonly AreaEntry[]>> = {
  messages: [
    {
      id: 'templates',
      title: 'Templates',
      blurb: 'Named messages you post with /message, and everything they carry.',
      icon: 'chat-circle-text',
      sections: ['general'],
      panels: ['templates'],
      count: (config) => tally(config, 'templates', 'template'),
    },
    {
      id: 'components',
      title: 'Components',
      blurb: 'Rows of buttons and dropdowns to drop into any template.',
      icon: 'layout',
      panels: ['components'],
      count: (config) => tally(config, 'components', 'component'),
    },
  ],

  leveling: [
    {
      id: 'earning',
      title: 'Earning XP',
      blurb: 'How much XP a message or a minute in voice is worth, and who is excluded.',
      icon: 'chart-bar',
      sections: ['message', 'voice', 'exclusions'],
    },
    {
      id: 'levelup',
      title: 'Level-up announcement',
      blurb: 'Where Proton says somebody levelled up, and what it says.',
      icon: 'megaphone',
      sections: ['announce'],
      panels: ['levelUpMessage'],
    },
    {
      id: 'rewards',
      title: 'Role rewards',
      blurb: 'Roles handed out at a level, and whether earlier ones are kept.',
      icon: 'user-plus',
      sections: ['rewards'],
      panels: ['roleRewards'],
      count: (config) => tally(config, 'roleRewards', 'reward'),
    },
    {
      id: 'card',
      title: 'Rank card',
      blurb: 'The image /rank draws.',
      icon: 'layout',
      sections: ['general', 'card'],
      panels: ['Rank card preview'],
    },
  ],

  welcome: [
    {
      id: 'welcome',
      title: 'Welcome message',
      blurb: 'Posted when somebody joins, with the channel it lands in.',
      icon: 'hand-waving',
      sections: ['general', 'welcome'],
      panels: ['welcomeMessage'],
    },
    {
      id: 'goodbye',
      title: 'Goodbye message',
      blurb: 'Posted when somebody leaves, with the channel it lands in.',
      icon: 'sign-out',
      sections: ['goodbye'],
      panels: ['goodbyeMessage'],
    },
    {
      id: 'card',
      title: 'Welcome card',
      blurb: 'The image drawn onto the greeting.',
      icon: 'layout',
      sections: ['card'],
      panels: ['Card preview'],
    },
  ],
};

// The closed set an area icon may come from. scripts/build-icons.ts reads it, so a name added here
// without re-running it stops being an IconName rather than turning into a blank square.
export const AREA_ICON_NAMES: readonly IconName[] = [
  ...new Set(Object.values(MODULE_AREAS).flatMap((areas) => areas.map((area) => area.icon))),
];

// Object.hasOwn, not a lookup-and-test: MODULE_AREAS['constructor'] would otherwise be truthy.
export function areasFor(moduleId: string): readonly AreaEntry[] {
  return Object.hasOwn(MODULE_AREAS, moduleId) ? (MODULE_AREAS[moduleId] ?? []) : [];
}

export function activeArea(moduleId: string, area: unknown): AreaEntry | undefined {
  return areasFor(moduleId).find((entry) => entry.id === area);
}

export function resolveArea(moduleId: string, area: unknown): AreaEntry | undefined {
  if (area === undefined) return undefined;

  const entry = activeArea(moduleId, area);
  if (entry) return entry;

  const known = areasFor(moduleId).map((candidate) => `'${candidate.id}'`);

  throw new Error(
    `The '${moduleId}' module has no '${String(area)}' area — ${
      known.length > 0 ? `it has ${known.join(', ')}` : 'its settings are one page'
    }. Remove the area parameter from the address bar to open it.`,
  );
}

export interface SectionLike {
  id: string;
  fields: string[];
}

export function areaFieldRoots(
  area: AreaEntry,
  sections: readonly SectionLike[] | undefined,
): Set<string> {
  const wanted = new Set(area.sections ?? []);

  return new Set((sections ?? []).filter((s) => wanted.has(s.id)).flatMap((s) => s.fields));
}

// Rendering only. The full descriptor list still backs the form values and toConfig — filtering
// that instead would write an area's own fields over the config and drop every other area's.
export function shownDescriptors<T extends { path: string }>(
  area: AreaEntry | undefined,
  descriptors: readonly T[],
  sections: readonly SectionLike[] | undefined,
): readonly T[] {
  if (!area) return descriptors;

  // Matched on the path's first segment, the way groupBySection claims one: a section declares
  // `rankCard` and the descriptors under it are `rankCard.background`, so an exact compare here
  // would empty every area holding a nested field.
  const roots = areaFieldRoots(area, sections);

  return descriptors.filter((descriptor) => roots.has(descriptor.path.split('.')[0] ?? ''));
}

// Which area a field ends up on. The command palette jumps straight to a field by path, and on an
// area'd module the settings root is the hub — so without this the jump lands somewhere the field
// is not rendered and the hash matches nothing.
export function areaForField(
  moduleId: string,
  path: string,
  sections: readonly SectionLike[] | undefined,
): AreaEntry | undefined {
  const root = path.split('.')[0] ?? '';

  return areasFor(moduleId).find((area) => areaFieldRoots(area, sections).has(root));
}

export function shownSections<T extends SectionLike>(
  area: AreaEntry | undefined,
  sections: readonly T[] | undefined,
): readonly T[] | undefined {
  if (!area) return sections;

  const wanted = new Set(area.sections ?? []);
  return (sections ?? []).filter((section) => wanted.has(section.id));
}

export function shownPanels<T extends { key: string | null; title: string }>(
  area: AreaEntry | undefined,
  panels: readonly T[],
): readonly T[] {
  if (!area) return panels;

  const wanted = new Set(area.panels ?? []);
  return panels.filter((panel) => wanted.has(panel.key ?? panel.title));
}
