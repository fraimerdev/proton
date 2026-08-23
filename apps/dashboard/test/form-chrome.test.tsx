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
