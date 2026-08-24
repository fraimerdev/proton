import { describe, expect, test } from 'bun:test';
import type { FieldDescriptor } from '@proton/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneratedForm, sectionKey } from '../src/components/form/generated-form.tsx';

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

function form(descriptors: readonly FieldDescriptor[], props = {}): string {
  return render(
    <GeneratedForm descriptors={descriptors} values={{}} onChange={() => undefined} {...props} />,
  );
}

const PLAIN: FieldDescriptor = {
  kind: 'string',
  path: 'response',
  label: 'Reply text',
  optional: false,
};

const DESCRIBED: FieldDescriptor = {
  ...PLAIN,
  description: 'Kept only where the consequence is not on the row',
};

describe('a field description', () => {
  test('renders behind an info button rather than as text on the row', () => {
    const html = form([DESCRIBED]);

    expect(html).toContain('field-info-button');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('Kept only where the consequence is not on the row');
    expect(html).not.toContain('field-description');
  });

  test('is still what aria-describedby on the control points at', () => {
    const html = form([DESCRIBED]);

    const tooltip = /<span class="field-tooltip" role="tooltip" id="([^"]+)"/.exec(html);
    expect(tooltip?.[1]).toBeDefined();
    expect(html).toContain(`aria-describedby="${tooltip?.[1]}"`);
  });

  test('leaves no info button behind when the field has none', () => {
    const html = form([PLAIN]);

    expect(html).not.toContain('field-info');
    expect(html).not.toContain('role="tooltip"');
    expect(html).toContain('Reply text');
  });

  test('names its own control, so the label is clickable and the row is not', () => {
    const html = form([PLAIN]);

    const label = /<label class="field-label" for="([^"]+)"/.exec(html);
    expect(label?.[1]).toBeDefined();
    expect(html).toContain(`id="${label?.[1]}"`);
  });

  test('is carried once by a list, not repeated on each of its rows', () => {
    const html = form([{ ...DESCRIBED, path: 'domains', label: 'Domain', array: true }], {
      values: { domains: ['a.example', 'b.example'] },
    });

    expect([...html.matchAll(/role="tooltip"/g)]).toHaveLength(1);
  });
});

const SECTIONS = [{ id: 'general', title: 'General', fields: ['response'] }];

describe('the section card', () => {
  test('puts the title in a header that collapses the body', () => {
    const html = form([PLAIN], { sections: SECTIONS });

    expect(html).toContain('form-section-toggle');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('>General<');

    const controls = /aria-controls="([^"]+)"/.exec(html);
    expect(html).toContain(`<div class="form-section-body" id="${controls?.[1]}"`);
  });

  test('renders open on the server, since the stored state is not readable there', () => {
    expect(form([PLAIN], { sections: SECTIONS })).not.toContain('hidden=""');
  });

  test('gives a group no section claims a card without a header to collapse', () => {
    const html = form([PLAIN]);

    expect(html).toContain('form-section-body');
    expect(html).not.toContain('form-section-head');
  });
});

describe('sectionKey', () => {
  // Section ids repeat across modules — every one of them has a 'general' — so the remembered
  // collapse of one module's section must not close another's.
  test('scopes a section id to its module', () => {
    expect(sectionKey('leveling', 'general')).toBe('leveling:general');
    expect(sectionKey('welcome', 'general')).not.toBe(sectionKey('leveling', 'general'));
  });

  test('leaves an unscoped form addressing its sections by bare id', () => {
    expect(sectionKey(undefined, 'general')).toBe('general');
  });
});

const SEVERITY = (path: string, label: string): FieldDescriptor => ({
  kind: 'enum',
  path,
  label,
  optional: false,
  options: ['off', 'low', 'medium', 'high'],
});

const NUMBER = (path: string, label: string): FieldDescriptor => ({
  kind: 'number',
  path,
  label,
  optional: false,
});

const RULES: FieldDescriptor[] = [
  SEVERITY('floodSeverity', 'Message flood'),
  NUMBER('floodCount', 'Flood: messages'),
  SEVERITY('capsSeverity', 'Shouting'),
  NUMBER('capsRatio', 'Caps: percent'),
];

describe('a rule whose severity is off', () => {
  const off = form(RULES, { values: { floodSeverity: 'off', capsSeverity: 'medium' } });

  test('hides its settings rather than removing them', () => {
    expect(off).toContain('class="rule-body" hidden');
  });

  /**
   * The save writes every value, hidden or not, so a hidden field can still be the one the API
   * rejects — and the command palette indexes it by path and scrolls to its [data-path]. Unmounting
   * it made both of those land on nothing.
   */
  test('keeps every settings path addressable in the document', () => {
    for (const path of ['floodCount', 'capsRatio']) {
      expect(`${path}: ${off.includes(`data-path="${path}"`)}`).toBe(`${path}: true`);
    }
  });

  test('a rule that is on is not hidden', () => {
    const shown = form(RULES, { values: { floodSeverity: 'high', capsSeverity: 'medium' } });

    expect(shown).not.toContain('hidden');
  });
});

const CATEGORY_KEYS = ['server', 'channels', 'roles', 'members'];

const MATRIX_FIELDS: FieldDescriptor[] = [
  ...CATEGORY_KEYS.map((key) => ({
    kind: 'boolean' as const,
    path: `categories.${key}`,
    label: key[0]?.toUpperCase() + key.slice(1),
    optional: false,
  })),
  ...CATEGORY_KEYS.map((key) => ({
    kind: 'channel-id' as const,
    path: `categoryChannels.${key}`,
    label: key[0]?.toUpperCase() + key.slice(1),
    optional: false,
    defaultValue: '',
  })),
];

const MATRIX_SECTION = [
  { id: 'categories', title: 'Categories', fields: ['categories', 'categoryChannels'] },
];

describe('a section declared as a matrix', () => {
  const html = form(MATRIX_FIELDS, { sections: MATRIX_SECTION, scope: 'serverlog' });

  test('renders one table row per key rather than one form row per field', () => {
    expect(html.split('<tr').length - 1).toBe(CATEGORY_KEYS.length + 1);
    expect(html).not.toContain('class="field field-boolean"');
  });

  test('each label is printed once, as the row header', () => {
    expect(html.split('>Server<').length - 1).toBe(1);
    expect(html).toContain('scope="row"');
  });

  test('the column headers name the two controls', () => {
    expect(html).toContain('>Logged<');
    expect(html).toContain('>Channel<');
  });

  // Every switch in the column is labelled "Server", "Channels"... and so is every picker. Without
  // a per-cell name the accessibility tree is thirteen pairs of identical controls.
  test('every control is named by its row and its column', () => {
    expect(html).toContain('Server — Logged');
    expect(html).toContain('Server — Channel');
  });

  test('an empty category channel reads as inheriting, not as unset', () => {
    expect(html).toContain('Inherit');
    expect(html).not.toContain('Select a channel');
  });
});

describe('the matrix declines a shape it cannot fill', () => {
  test('a module with no matrix declared keeps its plain rows', () => {
    const html = form(MATRIX_FIELDS, { sections: MATRIX_SECTION, scope: 'automod' });

    expect(html).not.toContain('class="matrix"');
  });

  test('a leaf only one column has drops the whole table rather than a row', () => {
    const lopsided = MATRIX_FIELDS.filter((d) => d.path !== 'categoryChannels.members');
    const html = form(lopsided, { sections: MATRIX_SECTION, scope: 'serverlog' });

    expect(html).not.toContain('class="matrix"');
    expect(html).toContain('data-path="categories.members"');
  });
});
