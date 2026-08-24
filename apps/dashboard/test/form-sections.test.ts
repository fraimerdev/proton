import { describe, expect, test } from 'bun:test';
import type { FieldDescriptor } from '@proton/core';
import { type FormSection, groupBySection } from '../src/components/form/generated-form.tsx';

function field(path: string): FieldDescriptor {
  return { kind: 'boolean', path, label: path, optional: false } as FieldDescriptor;
}

const SECTIONS: FormSection[] = [
  { id: 'general', title: 'General', fields: ['enabled'] },
  { id: 'voice', title: 'Voice XP', fields: ['voiceXpPerMinute', 'afkChannelId'] },
];

describe('groupBySection', () => {
  test('with no sections, everything lands in one untitled group', () => {
    const groups = groupBySection([field('a'), field('b')], undefined);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBeNull();
    expect(groups[0]?.descriptors).toHaveLength(2);
  });

  test('fields are grouped under the section that claims them', () => {
    const groups = groupBySection(
      [field('enabled'), field('voiceXpPerMinute'), field('afkChannelId')],
      SECTIONS,
    );

    expect(groups.map((g) => g.title)).toEqual(['General', 'Voice XP']);
    expect(groups[1]?.descriptors.map((d) => d.path)).toEqual(['voiceXpPerMinute', 'afkChannelId']);
  });

  test('a field no section claims still renders, in a trailing group', () => {
    const groups = groupBySection([field('enabled'), field('orphan')], SECTIONS);

    expect(groups.at(-1)?.title).toBeNull();
    expect(groups.at(-1)?.descriptors.map((d) => d.path)).toEqual(['orphan']);
  });

  test('a section claims nested paths by their first segment', () => {
    const groups = groupBySection([field('voiceXpPerMinute.floor')], SECTIONS);

    expect(groups[0]?.title).toBe('Voice XP');
  });

  test('a section that claims nothing present is omitted rather than shown empty', () => {
    const groups = groupBySection([field('enabled')], SECTIONS);

    expect(groups.map((g) => g.title)).toEqual(['General']);
  });

  test('every descriptor appears exactly once', () => {
    const descriptors = [field('enabled'), field('voiceXpPerMinute'), field('orphan')];
    const flattened = groupBySection(descriptors, SECTIONS).flatMap((g) => g.descriptors);

    expect(flattened).toHaveLength(descriptors.length);
    expect(new Set(flattened.map((d) => d.path)).size).toBe(descriptors.length);
  });
});

describe('what the generator refuses to render', () => {
  // An area declaring only panels reaches here with nothing to show, and the untitled group it used
  // to return rendered as an empty bordered card above the panel.
  test('nothing to show is no groups, not one empty group', () => {
    expect(groupBySection([], SECTIONS)).toEqual([]);
    expect(groupBySection([], undefined)).toEqual([]);
  });
});

describe('field order comes from the section, not the schema', () => {
  const paired: FormSection[] = [
    { id: 'routing', title: 'Routing', fields: ['toggles', 'channels'] },
  ];

  // Serverlog declares its categories as two parallel objects. Walking the Zod shape puts all
  // thirteen switches before all thirteen pickers; the manifest's own order interleaves them.
  test('two roots interleave in the order the manifest lists them', () => {
    const groups = groupBySection(
      [
        field('channels.server'),
        field('channels.roles'),
        field('toggles.server'),
        field('toggles.roles'),
      ],
      paired,
    );

    expect(groups[0]?.descriptors.map((d) => d.path)).toEqual([
      'toggles.server',
      'toggles.roles',
      'channels.server',
      'channels.roles',
    ]);
  });

  test('order within one root is left exactly as the schema gave it', () => {
    const groups = groupBySection(
      [field('toggles.b'), field('toggles.a'), field('toggles.c')],
      paired,
    );

    expect(groups[0]?.descriptors.map((d) => d.path)).toEqual([
      'toggles.b',
      'toggles.a',
      'toggles.c',
    ]);
  });
});
