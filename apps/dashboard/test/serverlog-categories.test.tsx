import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zodToDescriptors } from '@proton/core';
import { LOG_CATEGORY_KEYS, serverlogFormSchema } from '@proton/module-serverlog/config';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleForm } from '../src/components/module/form.ts';
import { ChannelField, ModuleFormProvider, Toggle } from '../src/components/module/inputs.tsx';

/**
 * Serverlog keeps a category's switch and a category's channel in two parallel objects over one set
 * of keys, and the page draws them as the table they are. Written out as plain rows the section was
 * twenty-six of them, thirteen labels twice over, with a category's two halves a full screen apart.
 *
 * Read as source rather than rendered: the table lives inside the route file, which cannot be
 * imported here — its loader reaches `src/server/modules.ts`, and importing that validates the
 * dashboard's env and throws. So the page's own row list is parsed out below and checked against
 * the module, and the cell markup the page asks for is rendered on its own underneath.
 */
const SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId', 'serverlog.tsx'),
  'utf8',
);

interface Row {
  key: string;
  label: string;
  on: boolean;
}

const ROWS: Row[] = [
  ...SOURCE.matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*on:\s*(true|false)\s*\}/g),
].map((match) => ({ key: match[1] ?? '', label: match[2] ?? '', on: match[3] === 'true' }));

// The page's own templates, matched as the text they are rather than written as strings a linter
// reads as broken interpolation.
const SWITCH_PATH = /path=\{`categories\.\$\{category\.key\}`\}/;
const CHANNEL_PATH = /path=\{`categoryChannels\.\$\{category\.key\}`\}/;
const CELL_NAME = /name: `\$\{category\.label\} — (Logged|Channel)`/g;

function occurrences(pattern: RegExp): number {
  return (SOURCE.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

const DESCRIPTORS = zodToDescriptors(serverlogFormSchema);

function under(root: string): string[] {
  return DESCRIPTORS.filter((descriptor) => descriptor.path.startsWith(`${root}.`)).map(
    (descriptor) => descriptor.path.slice(root.length + 1),
  );
}

function descriptorFor(path: string) {
  const found = DESCRIPTORS.find((descriptor) => descriptor.path === path);
  if (!found) throw new Error(`the serverlog schema has no '${path}'`);

  return found;
}

// Only the five members a static render reaches; the rest of ModuleForm is queries and mutations.
function render(node: ReactElement): string {
  const form = {
    value: (_path: string, fallback?: unknown) => fallback,
    set: () => undefined,
    report: () => undefined,
    channels: [],
    roles: [],
  } as unknown as ModuleForm;

  return renderToStaticMarkup(<ModuleFormProvider form={form}>{node}</ModuleFormProvider>);
}

describe('the categories table', () => {
  test('is one row per category, not one row per field', () => {
    const owned = DESCRIPTORS.filter(
      (descriptor) =>
        descriptor.path.startsWith('categories.') ||
        descriptor.path.startsWith('categoryChannels.'),
    );

    expect(ROWS.length).toBeGreaterThan(0);
    expect(ROWS.length * 2).toBe(owned.length);

    // The header's and the one the map writes. Thirteen rows spelled out is the same section by
    // another name, and it is what drifts.
    expect(SOURCE.match(/<tr[ >]/g) ?? []).toHaveLength(2);
    expect(SOURCE).toContain('<table className="matrix">');
  });

  test('has a row for every category the module declares, and for no key it does not', () => {
    const keys = ROWS.map((row) => row.key).sort();

    expect(keys).toEqual([...LOG_CATEGORY_KEYS].sort());
    expect(keys).toEqual(under('categories').sort());
    expect(keys).toEqual(under('categoryChannels').sort());
    expect(new Set(keys).size).toBe(ROWS.length);
  });

  test('names and defaults each row from the module, not from an idea of its own', () => {
    for (const row of ROWS) {
      const toggle = descriptorFor(`categories.${row.key}`);
      const channel = descriptorFor(`categoryChannels.${row.key}`);

      expect(`${row.key}: ${row.label}`).toBe(`${row.key}: ${toggle.label}`);
      expect(`${row.key}: ${row.label}`).toBe(`${row.key}: ${channel.label}`);
      expect(`${row.key} on: ${row.on}`).toBe(`${row.key} on: ${toggle.defaultValue}`);
    }
  });

  test('pairs a category’s switch with a category’s channel on the same row', () => {
    const row = /<tr key=\{category\.key\}>([\s\S]*?)<\/tr>/.exec(SOURCE)?.[1];
    if (row === undefined) throw new Error('the table no longer maps its rows over the categories');

    expect(row).toMatch(SWITCH_PATH);
    expect(row).toMatch(CHANNEL_PATH);
    expect(row).toContain('<th scope="row">{category.label}</th>');

    // Bound once each, from the row, and nowhere else: a path written out by hand somewhere below
    // is the twenty-six-row section growing back one field at a time.
    expect(occurrences(SWITCH_PATH)).toBe(1);
    expect(occurrences(CHANNEL_PATH)).toBe(1);
    expect(SOURCE).not.toMatch(/path=["']categor/);
  });

  test('carries the label its cells fall back to once the table reflows on a phone', () => {
    const styles = readFileSync(join(import.meta.dir, '..', 'src', 'styles.css'), 'utf8');

    expect(SOURCE).toContain('data-kind="boolean" data-label="Logged"');
    expect(SOURCE).toContain('data-kind="channel-id" data-label="Channel"');
    expect(styles).toContain('content: attr(data-label)');
  });
});

describe('what a cell in that table is called', () => {
  const first = ROWS[0];
  if (!first) throw new Error('no category rows to name');

  test('the page asks for a name per cell, since a column shares one label', () => {
    expect([...SOURCE.matchAll(CELL_NAME)].map((match) => match[1])).toEqual(['Logged', 'Channel']);
    expect(SOURCE).toContain("emptyLabel: 'Inherit'");
  });

  // What those names turn into. A row of switches all called "Logged" is a row nobody can navigate
  // by ear, so the label is off screen but never absent.
  test('a switch is named for its row and labelled nowhere on it', () => {
    const html = render(
      <Toggle
        path={`categories.${first.key}`}
        label={first.label}
        defaultValue={first.on}
        param={{ label: undefined, name: `${first.label} — Logged` }}
      />,
    );

    expect(html).toContain(
      `<span class="rule-param field-boolean" data-path="categories.${first.key}">`,
    );
    expect(
      new RegExp(`<label class="sr-only" for="[^"]+">${first.label} — Logged</label>`).test(html),
    ).toBe(true);
  });

  test('an unset channel reads as Inherit, which is what an empty one does', () => {
    const html = render(
      <ChannelField
        path={`categoryChannels.${first.key}`}
        label={first.label}
        channelTypes={[0, 5]}
        defaultValue=""
        param={{ label: undefined, name: `${first.label} — Channel`, emptyLabel: 'Inherit' }}
      />,
    );

    expect(html).toContain(`aria-label="${first.label} — Channel: Inherit"`);
    expect(html).toContain('>Inherit</span>');
    expect(html).not.toContain('No channel');
  });
});
