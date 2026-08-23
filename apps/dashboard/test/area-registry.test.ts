import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zodToDescriptors } from '@proton/core';
import { levelingFormSchema } from '@proton/module-leveling/config';
import { messagesFormSchema } from '@proton/module-messages/config';
import { welcomeFormSchema } from '@proton/module-welcome/config';
import type { z } from 'zod';
import {
  type AreaEntry,
  activeArea,
  areaForField,
  areasFor,
  MODULE_AREAS,
  resolveArea,
  shownDescriptors,
  shownPanels,
  shownSections,
} from '../src/components/panels/areas.ts';
import { panelsFor } from '../src/components/panels/registry.ts';
import { MODULE_SWITCH_PATH } from '../src/components/shell/module-meta.ts';

const MODULES = join(import.meta.dir, '..', '..', '..', 'packages', 'modules');

// The form schema, not the config schema: the descriptors the dashboard actually renders come
// from this one, and the config schema still carries the panel-backed keys it omits.
const FORM_SCHEMAS: Record<string, z.ZodObject> = {
  leveling: levelingFormSchema,
  messages: messagesFormSchema,
  welcome: welcomeFormSchema,
};

interface Section {
  id: string;
  fields: string[];
}

/**
 * The manifest's own sections, read out of its source. Importing the manifest instead would drag
 * discord.js, drizzle and the card rasteriser's native addon into a dashboard test to read four
 * string literals.
 */
function sectionsOf(moduleId: string): Section[] {
  const source = readFileSync(join(MODULES, moduleId, 'src', 'index.ts'), 'utf8');

  const opens = source.indexOf('sections: [');
  if (opens === -1) throw new Error(`no dashboard sections found in the ${moduleId} manifest`);

  // Bracket-balanced rather than matched to a closing indent: a manifest is free to declare its
  // sections on one line, and the messages module does.
  let depth = 0;
  let end = -1;
  for (let i = opens + 'sections: '.length; i < source.length; i += 1) {
    const char = source[i];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`unbalanced dashboard sections in the ${moduleId} manifest`);

  const declared = source.slice(opens, end);

  return [...declared.matchAll(/\{\s*id:\s*'([^']+)',[\s\S]*?fields:\s*\[([^\]]*)\]/g)].map(
    (match) => ({
      id: match[1] ?? '',
      fields: [...(match[2] ?? '').matchAll(/'([^']+)'/g)].map((field) => field[1] ?? ''),
    }),
  );
}

const AREA_MODULES = Object.keys(MODULE_AREAS);

describe('the area registry reads real modules', () => {
  test('it registers at least one module, or everything below proves nothing', () => {
    expect(AREA_MODULES.length).toBeGreaterThan(0);
  });

  test('the manifest sections parse out of source at all', () => {
    for (const moduleId of AREA_MODULES) {
      expect(`${moduleId}: ${sectionsOf(moduleId).length > 0}`).toBe(`${moduleId}: true`);
    }
  });

  test('every area names a section the manifest actually declares', () => {
    for (const moduleId of AREA_MODULES) {
      const declared = new Set(sectionsOf(moduleId).map((section) => section.id));

      for (const area of areasFor(moduleId)) {
        for (const id of area.sections ?? []) {
          expect(`${moduleId}/${area.id} -> ${id}: ${declared.has(id)}`).toBe(
            `${moduleId}/${area.id} -> ${id}: true`,
          );
        }
      }
    }
  });

  test('every area names a panel the panel registry actually holds', () => {
    for (const moduleId of AREA_MODULES) {
      const held = new Set(panelsFor(moduleId).map((panel) => panel.key ?? panel.title));

      for (const area of areasFor(moduleId)) {
        for (const key of area.panels ?? []) {
          expect(`${moduleId}/${area.id} -> ${key}: ${held.has(key)}`).toBe(
            `${moduleId}/${area.id} -> ${key}: true`,
          );
        }
      }
    }
  });
});

/**
 * The hub is the only way into an area'd module's settings, so anything no area claims can no
 * longer be reached at all. Unlike a forgotten field on a flat page — which groupBySection still
 * renders in a trailing group — this loses it silently while the save path keeps writing it.
 */
describe('nothing becomes unreachable', () => {
  test('every manifest section belongs to exactly one area', () => {
    for (const moduleId of AREA_MODULES) {
      const claims = new Map<string, string[]>();

      for (const area of areasFor(moduleId)) {
        for (const id of area.sections ?? []) claims.set(id, [...(claims.get(id) ?? []), area.id]);
      }

      for (const section of sectionsOf(moduleId)) {
        expect(`${moduleId}/${section.id} claimed by: ${claims.get(section.id) ?? []}`).toBe(
          `${moduleId}/${section.id} claimed by: ${claims.get(section.id)?.[0] ?? 'nobody'}`,
        );
      }
    }
  });

  test('every panel belongs to exactly one area', () => {
    for (const moduleId of AREA_MODULES) {
      const claims = new Map<string, string[]>();

      for (const area of areasFor(moduleId)) {
        for (const key of area.panels ?? []) claims.set(key, [...(claims.get(key) ?? []), area.id]);
      }

      for (const panel of panelsFor(moduleId)) {
        const key = panel.key ?? panel.title;

        expect(`${moduleId}/${key} claimed by: ${claims.get(key) ?? []}`).toBe(
          `${moduleId}/${key} claimed by: ${claims.get(key)?.[0] ?? 'nobody'}`,
        );
      }
    }
  });

  test('every configurable field lands in some area', () => {
    for (const moduleId of AREA_MODULES) {
      const schema = FORM_SCHEMAS[moduleId];
      if (!schema) throw new Error(`no form schema wired up for '${moduleId}'`);

      const sections = sectionsOf(moduleId);
      const descriptors = zodToDescriptors(schema).filter(
        (descriptor) => descriptor.path !== MODULE_SWITCH_PATH,
      );

      const reached = new Set(
        areasFor(moduleId).flatMap((area) =>
          shownDescriptors(area, descriptors, sections).map((descriptor) => descriptor.path),
        ),
      );

      for (const descriptor of descriptors) {
        expect(`${moduleId}/${descriptor.path} reachable: ${reached.has(descriptor.path)}`).toBe(
          `${moduleId}/${descriptor.path} reachable: true`,
        );
      }
    }
  });
});

describe('resolveArea', () => {
  const moduleId = AREA_MODULES[0] ?? 'leveling';

  test('no area parameter opens the hub rather than throwing', () => {
    expect(resolveArea(moduleId, undefined)).toBeUndefined();
  });

  test('a registered id resolves to its entry', () => {
    const first = areasFor(moduleId)[0];

    expect(resolveArea(moduleId, first?.id)).toBe(first);
  });

  test('an unknown id names the areas the module does have', () => {
    const names = areasFor(moduleId).map((area) => `'${area.id}'`);

    expect(() => resolveArea(moduleId, 'widgets')).toThrow(
      `The '${moduleId}' module has no 'widgets' area — it has ${names.join(', ')}. Remove the area parameter from the address bar to open it.`,
    );
  });

  test('a module with no areas says its settings are one page', () => {
    expect(() => resolveArea('ping', 'anything')).toThrow('its settings are one page');
  });

  test('a non-string area is described rather than dying as a raw type error', () => {
    expect(() => resolveArea(moduleId, 7)).toThrow("no '7' area");
  });

  test('areasFor never answers for a prototype key', () => {
    expect(areasFor('constructor')).toEqual([]);
    expect(activeArea('constructor', 'x')).toBeUndefined();
  });
});

const FIELDS = [
  { path: 'rankCard.background', kind: 'string' },
  { path: 'rankCard.accent', kind: 'string' },
  { path: 'voiceXpPerMinute', kind: 'number' },
] as const;

const SECTIONS: Section[] = [
  { id: 'card', fields: ['rankCard'] },
  { id: 'voice', fields: ['voiceXpPerMinute'] },
];

const CARD_AREA: AreaEntry = {
  id: 'card',
  title: 'Card',
  blurb: '',
  icon: 'layout',
  sections: ['card'],
};

describe('areaForField', () => {
  test('finds the area holding a nested path', () => {
    expect(areaForField('leveling', 'rankCard.background', sectionsOf('leveling'))?.id).toBe(
      'card',
    );
  });

  test('finds the area holding a flat path', () => {
    expect(areaForField('leveling', 'voiceXpPerMinute', sectionsOf('leveling'))?.id).toBe(
      'earning',
    );
  });

  // Every field of an area'd module has to answer, or the palette jump lands on the hub with a
  // hash nothing on the page matches.
  test('answers for every configurable field of every area’d module', () => {
    for (const moduleId of AREA_MODULES) {
      const schema = FORM_SCHEMAS[moduleId];
      if (!schema) throw new Error(`no form schema wired up for '${moduleId}'`);

      const sections = sectionsOf(moduleId);

      for (const descriptor of zodToDescriptors(schema)) {
        if (descriptor.path === MODULE_SWITCH_PATH) continue;

        const area = areaForField(moduleId, descriptor.path, sections);
        expect(`${moduleId}/${descriptor.path}: ${area?.id ?? 'nowhere'}`).not.toContain('nowhere');
      }
    }
  });

  test('a module with no areas sends the palette to its one settings page', () => {
    expect(
      areaForField('ping', 'response', [{ id: 'general', fields: ['response'] }]),
    ).toBeUndefined();
  });
});

describe('what an area shows', () => {
  test('a nested path is claimed by the section naming its first segment', () => {
    expect(shownDescriptors(CARD_AREA, FIELDS, SECTIONS).map((f) => f.path)).toEqual([
      'rankCard.background',
      'rankCard.accent',
    ]);
  });

  test('no area shows everything, so a module without areas is unchanged', () => {
    expect(shownDescriptors(undefined, FIELDS, SECTIONS)).toEqual(FIELDS);
    expect(shownSections(undefined, SECTIONS)).toEqual(SECTIONS);
  });

  test('an area declaring no sections shows no fields rather than all of them', () => {
    const panelOnly: AreaEntry = { id: 'p', title: 'P', blurb: '', icon: 'layout' };

    expect(shownDescriptors(panelOnly, FIELDS, SECTIONS)).toEqual([]);
    expect(shownSections(panelOnly, SECTIONS)).toEqual([]);
  });

  test('a panel with no key is addressed by its title', () => {
    const panels = [
      { key: 'roleRewards', title: 'Role rewards' },
      { key: null, title: 'Who enforces what' },
    ];
    const area: AreaEntry = {
      id: 'a',
      title: 'A',
      blurb: '',
      icon: 'layout',
      panels: ['Who enforces what'],
    };

    expect(shownPanels(area, panels).map((panel) => panel.title)).toEqual(['Who enforces what']);
  });
});
