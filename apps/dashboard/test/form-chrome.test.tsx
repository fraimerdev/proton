import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SectionCard } from '../src/components/form/section.tsx';
import type { ModuleForm } from '../src/components/module/form.ts';
import { ModuleFormProvider, Text, Tokens } from '../src/components/module/inputs.tsx';

// Only the five members a static render reaches; the rest of ModuleForm is queries and mutations.
function formOf(values: Record<string, unknown>): ModuleForm {
  return {
    value: (path: string, fallback?: unknown) =>
      Object.hasOwn(values, path) ? values[path] : fallback,
    set: () => undefined,
    report: () => undefined,
    channels: [],
    roles: [],
  } as unknown as ModuleForm;
}

function render(node: ReactNode, values: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ModuleFormProvider form={formOf(values)}>{node}</ModuleFormProvider>,
  );
}

const HELP = 'Kept only where the consequence is not on the row';

const PLAIN = <Text path="response" label="Reply text" />;
const DESCRIBED = <Text path="response" label="Reply text" help={HELP} />;

describe('a field description', () => {
  test('renders behind an info button rather than as text on the row', () => {
    const html = render(DESCRIBED);

    expect(html).toContain('field-info-button');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(HELP);
    expect(html).not.toContain('field-description');
  });

  test('is still what aria-describedby on the control points at', () => {
    const html = render(DESCRIBED);

    const tooltip = /<span class="field-tooltip" role="tooltip" id="([^"]+)"/.exec(html);
    expect(tooltip?.[1]).toBeDefined();
    expect(html).toContain(`aria-describedby="${tooltip?.[1]}"`);
  });

  test('leaves no info button behind when the field has none', () => {
    const html = render(PLAIN);

    expect(html).not.toContain('field-info');
    expect(html).not.toContain('role="tooltip"');
    expect(html).toContain('Reply text');
  });

  test('names its own control, so the label is clickable and the row is not', () => {
    const html = render(PLAIN);

    const label = /<label class="field-label" for="([^"]+)"/.exec(html);
    expect(label?.[1]).toBeDefined();
    expect(html).toContain(`id="${label?.[1]}"`);
  });

  test('is carried once by a list, not repeated on each of its entries', () => {
    const html = render(<Tokens path="domains" kind="string" label="Domain" help={HELP} />, {
      domains: ['a.example', 'b.example'],
    });

    expect([...html.matchAll(/role="tooltip"/g)]).toHaveLength(1);
  });
});

function card(title: string | null, children: ReactNode = PLAIN): string {
  return render(
    <SectionCard id="general" title={title}>
      {children}
    </SectionCard>,
  );
}

describe('the section card', () => {
  test('puts the title in a header that collapses the body', () => {
    const html = card('General');

    expect(html).toContain('form-section-toggle');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('>General<');

    const controls = /aria-controls="([^"]+)"/.exec(html);
    expect(html).toContain(`<div class="form-section-body" id="${controls?.[1]}"`);
  });

  test('renders open on the server, since the stored state is not readable there', () => {
    expect(card('General')).not.toContain('hidden=""');
  });

  test('gives a titleless card a body without a header to collapse', () => {
    const html = card(null);

    expect(html).toContain('form-section-body');
    expect(html).not.toContain('form-section-head');
  });
});

const ROUTES = join(import.meta.dir, '..', 'src', 'routes', 'dashboard', '$guildId');

function sectionIds(): { module: string; id: string }[] {
  return readdirSync(ROUTES)
    .filter((name) => name.endsWith('.tsx'))
    .flatMap((name) => {
      const source = readFileSync(join(ROUTES, name), 'utf8');

      return [...source.matchAll(/<SectionCard\s+id="([^"]+)"/g)].map((match) => ({
        module: name.replace(/\.tsx$/, ''),
        id: match[1] as string,
      }));
    });
}

describe('the id a section is remembered by', () => {
  // Section ids repeat across modules — every one of them has a 'general' — so the remembered
  // collapse of one module's section must not close another's. There is no longer a sectionKey()
  // doing the scoping: every id is written out by hand in its module's route, so the scoping is
  // only true while every one of them still carries its module.
  test('is scoped to its module', () => {
    for (const { module, id } of sectionIds()) {
      expect(`${module}: ${id}`).toBe(`${module}: ${module}:${id.slice(module.length + 1)}`);
    }
  });

  test('is claimed by exactly one section in the app', () => {
    const ids = sectionIds().map((section) => section.id);

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

// A guard for the two tests above rather than a behaviour of its own: they read the route files as
// text, and a switch to a computed id would leave them scanning for a pattern nothing matches and
// passing on an empty list.
test('every section id is a literal in its route, not one built at runtime', (): void => {
  for (const name of readdirSync(ROUTES).filter((file) => file.endsWith('.tsx'))) {
    const source = readFileSync(join(ROUTES, name), 'utf8');
    const written = [...source.matchAll(/<SectionCard\s+id=/g)].length;
    const literal = [...source.matchAll(/<SectionCard\s+id="/g)].length;

    expect(`${name}: ${written}`).toBe(`${name}: ${literal}`);
  }
});
