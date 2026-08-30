import { afterAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SectionCard } from '../src/components/form/section.tsx';
import type { ModuleForm } from '../src/components/module/form.ts';

const react = await import('react');

/**
 * The save gate below is written in an effect, and `renderToStaticMarkup` runs none. Rather than a
 * DOM, this collects what a render schedules so `drive` can run it: `useEffect` is the only name
 * taken off the real module, and with nothing collecting it stays the no-op the server dispatcher
 * already makes of it. Module mocks are process-wide and `bun test` runs every dashboard suite in
 * one process, so the real namespace goes back on the registry once this file is done.
 */
let scheduled: (() => unknown)[] | null = null;

mock.module('react', () => ({
  ...react,
  useEffect: (effect: () => unknown) => {
    scheduled?.push(effect);
  },
}));

afterAll(() => {
  scheduled = null;
  mock.module('react', () => react);
});

// Imported after the mock, or the `useEffect` these close over is the real one, bound before the
// swap. `SectionCard` above is imported before it on purpose: its effect reads localStorage.
const { Choice, Duration, ModuleFormProvider, Num, RoleField } = await import(
  '../src/components/module/inputs.tsx'
);

interface Reported {
  path: string;
  problem: string | null;
}

// Only the five members a static render reaches; the rest of ModuleForm is queries and mutations.
function formOf(values: Record<string, unknown>, reported: Reported[]): ModuleForm {
  return {
    value: (path: string, fallback?: unknown) =>
      Object.hasOwn(values, path) ? values[path] : fallback,
    set: () => undefined,
    report: (path: string, problem: string | null) => {
      reported.push({ path, problem });
    },
    channels: [],
    roles: [],
  } as unknown as ModuleForm;
}

function render(node: ReactElement, values: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ModuleFormProvider form={formOf(values, [])}>{node}</ModuleFormProvider>,
  );
}

// The same render, plus what it scheduled. Fields only: the section card's own effect reads
// localStorage, which nothing in this process has.
function drive(node: ReactElement, values: Record<string, unknown> = {}): Reported[] {
  const reported: Reported[] = [];
  const collected: (() => unknown)[] = [];

  scheduled = collected;
  renderToStaticMarkup(
    <ModuleFormProvider form={formOf(values, reported)}>{node}</ModuleFormProvider>,
  );
  scheduled = null;

  for (const effect of collected) effect();
  return reported;
}

const MODES = ['button', 'captcha', 'website'] as const;

const MODE_LABELS: Record<string, string> = {
  button: 'Press a button',
  captcha: 'Solve a captcha',
  website: 'Sign in on Proton’s website',
};

/**
 * Verification's captcha block, which is where this pattern is written by hand: the mode picker,
 * then the fields only one mode uses. `hidden` rather than a branch that renders nothing — a field
 * held off the page still carries a value the save will write, and the command palette still needs
 * a `[data-path]` to land on.
 */
function gate(mode: string): ReactElement {
  const notCaptcha = mode !== 'captcha';

  return (
    <>
      <Choice
        path="mode"
        label="How members verify"
        options={MODES}
        optionLabels={MODE_LABELS}
        defaultValue="button"
      />
      {/* Carries a description, and so an info button whose icon is `aria-hidden="true"`: an
          assertion that reads `not.toContain('hidden')` over the whole document breaks on this and
          nothing else. */}
      <Num
        path="captchaLength"
        label="Characters"
        help="How many characters the image carries"
        min={4}
        max={8}
        defaultValue={6}
        hidden={notCaptcha}
      />
      <Num
        path="captchaAttempts"
        label="Attempts allowed"
        min={1}
        max={5}
        defaultValue={3}
        hidden={notCaptcha}
      />
    </>
  );
}

const HIDDEN_LENGTH = '<div class="field field-number" data-path="captchaLength" hidden="">';
const SHOWN_LENGTH = '<div class="field field-number" data-path="captchaLength">';

describe('a field its mode does not show', () => {
  const html = render(gate('button'));

  test('carries hidden on its own root rather than in a wrapper around it', () => {
    expect(html).toContain(HIDDEN_LENGTH);
    expect(html).not.toContain('<div hidden=""><div class="field');
  });

  // `.field + .field` is the form's only row separator, so an element between two fields costs
  // the hairline above every row that follows it.
  test('is the immediate sibling of the field above it', () => {
    expect(html).toContain(`</div>${HIDDEN_LENGTH}`);
  });

  test('keeps its path addressable in the document', () => {
    for (const path of ['captchaLength', 'captchaAttempts']) {
      expect(`${path}: ${html.includes(`data-path="${path}"`)}`).toBe(`${path}: true`);
    }
  });

  test('drops the flag once the mode it belongs to is picked', () => {
    const shown = render(gate('captcha'));

    expect(shown).toContain(SHOWN_LENGTH);
    expect(shown).not.toContain(HIDDEN_LENGTH);
  });

  test('a field no mode conditions is never hidden', () => {
    const quiet = render(
      <>
        {gate('button')}
        <RoleField path="quarantineRoleId" label="Quarantine role" optional />
      </>,
    );

    expect(quiet).toContain('<div class="field field-role-id" data-path="quarantineRoleId">');
    expect(quiet).not.toContain('data-path="quarantineRoleId" hidden');

    // The trap the comment above names, asserted rather than described: every icon in the document
    // is aria-hidden, so 'hidden' is in the markup of a page hiding nothing at all.
    expect(render(gate('captcha'))).toContain('aria-hidden="true"');
  });
});

describe('a section every field of which its mode does not show', () => {
  // Otherwise switching to a mode that uses none of them leaves an empty titled card behind.
  const shut = render(
    <div hidden>
      <SectionCard id="verification:captcha" title="Captcha">
        {gate('button')}
      </SectionCard>
    </div>,
  );

  test('is hidden by a wrapper with no styling of its own, and still says what it is', () => {
    expect(shut).toContain('<div hidden=""><section class="form-section">');
    expect(shut).toContain('>Captcha<');
  });

  // The card is closed, not emptied: the save still writes what is inside it, and a palette jump
  // into one of these fields unhides its way down to the row.
  test('keeps every field inside it in the document, flagged one by one', () => {
    expect(shut).toContain(HIDDEN_LENGTH);
    expect(shut).toContain('data-path="captchaAttempts"');
  });

  test('is shown again when the mode it belongs to is picked', () => {
    const open = renderToStaticMarkup(
      <ModuleFormProvider form={formOf({}, [])}>
        <div hidden={false}>
          <SectionCard id="verification:captcha" title="Captcha">
            {gate('captcha')}
          </SectionCard>
        </div>
      </ModuleFormProvider>,
    );

    expect(open).toContain('<section class="form-section">');
    expect(open).toContain(SHOWN_LENGTH);
    expect(open).not.toContain('<div hidden=""><section');
  });
});

describe('the save gate on a duration it cannot read', () => {
  const expiry = (hidden: boolean): ReactElement => (
    <Duration
      path="captchaExpiry"
      label="Captcha expires after"
      defaultValue="5m"
      hidden={hidden}
    />
  );

  test('names the field the save is waiting on', () => {
    expect(drive(expiry(false), { captchaExpiry: '5 mins' })).toEqual([
      { path: 'captchaExpiry', problem: '“Captcha expires after” is not a duration yet.' },
    ]);
  });

  // Save is disabled by a field that is not on the page, and a save bar naming a setting the reader
  // cannot see is the whole reason the second wording exists.
  test('and says the page is not showing it, when the mode has it hidden', () => {
    expect(drive(expiry(true), { captchaExpiry: '5 mins' })).toEqual([
      {
        path: 'captchaExpiry',
        problem:
          '“Captcha expires after” is not a duration yet, and this page is not showing it right now.',
      },
    ]);
  });

  test('reports nothing to gate on once the text reads as a duration', () => {
    expect(drive(expiry(false), { captchaExpiry: '30m' })).toEqual([
      { path: 'captchaExpiry', problem: null },
    ]);
  });

  test('and nothing for a field left empty, which is the module default, not a typo', () => {
    expect(drive(expiry(false), { captchaExpiry: '' })).toEqual([
      { path: 'captchaExpiry', problem: null },
    ]);
  });
});

describe('the stylesheet actually hides what the markup marks hidden', () => {
  const styles = readFileSync(join(import.meta.dir, '..', 'src', 'styles.css'), 'utf8');

  // The markup assertions above prove the attribute is written, and nothing more. `[hidden]` lives
  // in the UA sheet, so any author `display` outranks it — `.field { display: grid }` rendered every
  // hidden row in full while carrying the attribute, and no string test could see it.
  test('declares its own [hidden] rule, because .field sets a display that outranks the browser’s', () => {
    expect(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styles)).toBe(true);
    expect(/\.field\s*\{[^}]*display:\s*grid/.test(styles)).toBe(true);
  });
});
