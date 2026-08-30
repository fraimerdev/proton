import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleForm } from '../src/components/module/form.ts';
import {
  Duration,
  ModuleFormProvider,
  Num,
  Rule,
  Tokens,
} from '../src/components/module/inputs.tsx';

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

function render(node: ReactElement, values: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ModuleFormProvider form={formOf(values)}>{node}</ModuleFormProvider>,
  );
}

const FLOOD = (
  <Rule id="flood" label="Message flood" path="floodSeverity">
    <Num
      path="floodCount"
      label="Messages"
      min={2}
      max={50}
      defaultValue={6}
      param={{ label: 'Messages' }}
    />
    <Duration path="floodWindow" label="Window" defaultValue="5s" param={{ label: 'Window' }} />
  </Rule>
);

const LINKS = (
  <Rule
    id="links"
    label="Blocked links"
    path="linksSeverity"
    stacked={
      <Tokens path="linkBlockDomains" kind="string" label="Blocked domains" maxItems={200} />
    }
  />
);

const OPEN = '<div class="rule-body">';
const SHUT = '<div class="rule-body" hidden="">';

describe('a rule switched off hides the settings it is not reading', () => {
  test('off hides them', () => {
    expect(render(FLOOD, { floodSeverity: 'off' })).toContain(SHUT);
    expect(render(FLOOD, { floodSeverity: 'medium' })).toContain(OPEN);
    expect(render(FLOOD, { floodSeverity: 'medium' })).not.toContain(SHUT);
  });

  test('a rule nobody has switched on yet starts closed on its own default', () => {
    expect(render(FLOOD)).toContain(SHUT);
  });

  // Hidden, never unmounted. An off check still holds real values that a save can be rejected for,
  // and the command palette still indexes them, so both need a [data-path] to land on.
  test('the parameters stay in the document in both states', () => {
    for (const severity of ['off', 'medium']) {
      const html = render(FLOOD, { floodSeverity: severity });

      for (const path of ['floodCount', 'floodWindow']) {
        expect(`${path} at ${severity}: ${html.includes(`data-path="${path}"`)}`).toBe(
          `${path} at ${severity}: true`,
        );
      }
    }
  });

  test('the row says which state it is in, for the reader and for the stylesheet', () => {
    expect(render(FLOOD, { floodSeverity: 'off' })).toContain(
      '<div class="rule" data-rule="flood" data-off="true">',
    );
    expect(render(FLOOD, { floodSeverity: 'medium' })).toContain(
      '<div class="rule" data-rule="flood">',
    );
  });

  // The one control that can undo it: inside the body, switching a rule off would take its own
  // switch off the page with it.
  test('the severity itself is in the head, not in the body it hides', () => {
    const html = render(FLOOD, { floodSeverity: 'off' });

    expect(html.indexOf('data-path="floodSeverity"')).toBeLessThan(html.indexOf('rule-body'));
    expect(html).toContain('<div class="rule-head">');
  });

  test('what counts as off is the rule’s to say, not the word “off”', () => {
    const graded = (
      <Rule
        id="graded"
        label="Graded"
        path="mode"
        options={['ignore', 'log', 'delete']}
        defaultValue="ignore"
        offValue="ignore"
      >
        <Num path="gradedLimit" label="Limit" defaultValue={5} param={{ label: 'Limit' }} />
      </Rule>
    );

    expect(render(graded, { mode: 'ignore' })).toContain(SHUT);
    expect(render(graded, { mode: 'log' })).toContain(OPEN);
  });
});

describe('a rule with nothing under its head', () => {
  // Rather than an empty hidden div: `.rule + .rule` is the row separator, and a body that is
  // never filled is still an element between the head and the rule below it.
  test('renders no body at all, in either state', () => {
    const bare = <Rule id="invites" label="Invite links" path="invitesSeverity" />;

    expect(render(bare, { invitesSeverity: 'off' })).not.toContain('rule-body');
    expect(render(bare, { invitesSeverity: 'high' })).not.toContain('rule-body');
    expect(render(bare, { invitesSeverity: 'off' })).toContain('data-off="true"');
  });
});

describe('a growing control stays stacked instead of joining the inline line', () => {
  test('a threshold is a cell on the rule’s own line', () => {
    const html = render(FLOOD, { floodSeverity: 'medium' });

    expect(html).toContain('<div class="rule-params">');
    expect(html).toContain('<span class="rule-param field-number" data-path="floodCount">');
  });

  test('a list is a field of its own beside that line, not a cell on it', () => {
    const html = render(LINKS, { linksSeverity: 'medium' });

    expect(html).toContain(
      '<div class="field field-array field-stacked" data-path="linkBlockDomains">',
    );
    expect(html).not.toContain('rule-params');
  });

  test('and is hidden with the rest of the body when the rule is off', () => {
    const html = render(LINKS, { linksSeverity: 'off' });

    expect(html).toContain(SHUT);
    expect(html).toContain('data-path="linkBlockDomains"');
    expect(html).not.toContain('data-path="linkBlockDomains" hidden');
  });
});

describe('a parameter whose label would say nothing new', () => {
  // The severity's label is the rule's label, already read aloud beside it — but two controls whose
  // only difference is their type are two identical names in the accessibility tree.
  test('is named for the accessibility tree and unlabelled on screen', () => {
    const html = render(FLOOD, { floodSeverity: 'medium' });

    expect(/<label class="sr-only" for="[^"]+">Message flood<\/label>/.test(html)).toBe(true);
    expect(/<label class="rule-param-label" for="[^"]+">Messages<\/label>/.test(html)).toBe(true);
  });
});

describe('the stylesheet actually hides what the rule marks hidden', () => {
  // The markup assertions above prove the attribute is written, and nothing more. `[hidden]` lives
  // in the UA sheet, so any author `display` outranks it, and `.rule-params` sets one.
  test('declares its own [hidden] rule', () => {
    const styles = readFileSync(join(import.meta.dir, '..', 'src', 'styles.css'), 'utf8');

    expect(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styles)).toBe(true);
    expect(styles).toContain('.rule-body');
  });
});
