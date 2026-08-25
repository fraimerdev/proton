import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldDescriptor } from '@proton/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { fieldIsHidden, GeneratedForm } from '../src/components/form/generated-form.tsx';
import { unreadableLine } from '../src/routes/dashboard/$guildId/$moduleId.tsx';

function form(descriptors: readonly FieldDescriptor[], props = {}): string {
  return renderToStaticMarkup(
    <GeneratedForm descriptors={descriptors} values={{}} onChange={() => undefined} {...props} />,
  );
}

const MODE: FieldDescriptor = {
  kind: 'enum',
  path: 'mode',
  label: 'How members verify',
  optional: false,
  options: ['button', 'captcha', 'website'],
  optionLabels: {
    button: 'Press a button',
    captcha: 'Solve a captcha',
    website: 'Sign in on the website',
  },
};

// Carries a description, and so an info button whose icon is `aria-hidden="true"`: an assertion
// that reads `not.toContain('hidden')` over the whole document breaks on this and nothing else.
const CAPTCHA_LENGTH: FieldDescriptor = {
  kind: 'number',
  path: 'captchaLength',
  label: 'Characters',
  description: 'How many characters the image carries',
  optional: false,
  showWhen: { path: 'mode', equals: ['captcha'] },
};

const CAPTCHA_ATTEMPTS: FieldDescriptor = {
  kind: 'number',
  path: 'captchaAttempts',
  label: 'Attempts allowed',
  optional: false,
  showWhen: { path: 'mode', equals: ['captcha'] },
};

const QUARANTINE_ROLE: FieldDescriptor = {
  kind: 'role-id',
  path: 'quarantineRoleId',
  label: 'Quarantine role',
  optional: true,
};

const CAPTCHA_EXPIRY: FieldDescriptor = {
  kind: 'duration',
  path: 'captchaExpiry',
  label: 'Captcha expires after',
  optional: false,
  showWhen: { path: 'mode', equals: ['captcha'] },
};

const FIELDS = [MODE, CAPTCHA_LENGTH, CAPTCHA_ATTEMPTS];

const HIDDEN_LENGTH = '<div class="field field-number" data-path="captchaLength" hidden="">';
const SHOWN_LENGTH = '<div class="field field-number" data-path="captchaLength">';

describe('a field its mode does not show', () => {
  const html = form(FIELDS, { values: { mode: 'button' } });

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
    const shown = form(FIELDS, { values: { mode: 'captcha' } });

    expect(shown).toContain(SHOWN_LENGTH);
    expect(shown).not.toContain(HIDDEN_LENGTH);
  });

  test('a field with no showWhen at all is never hidden', () => {
    const html = form([MODE, QUARANTINE_ROLE], { values: { mode: 'button' } });

    expect(html).toContain('<div class="field field-role-id" data-path="quarantineRoleId">');
    expect(html).not.toContain('data-path="quarantineRoleId" hidden');
  });
});

describe('a showWhen the form has no controller for', () => {
  // The module's own switch is filtered out of the generated form, so `values` never carries
  // `enabled` — and resolving it to undefined hid the field in both states with nothing said.
  const orphan: FieldDescriptor = {
    ...CAPTCHA_LENGTH,
    showWhen: { path: 'enabled', equals: ['true'] },
  };

  test('fails open: an extra field on the page beats a field nobody can reach', () => {
    expect(fieldIsHidden(orphan, { mode: 'button' })).toBe(false);
    expect(form([MODE, orphan], { values: { mode: 'button' } })).toContain(SHOWN_LENGTH);
  });

  test('a controller the form does carry still hides it', () => {
    expect(fieldIsHidden(orphan, { enabled: false })).toBe(true);
    expect(fieldIsHidden(orphan, { enabled: 'true' })).toBe(false);
  });
});

const SECTIONS = [
  { id: 'general', title: 'General', fields: ['mode'] },
  { id: 'captcha', title: 'Captcha', fields: ['captchaLength', 'captchaAttempts'] },
];

describe('a section every field of which is hidden', () => {
  // Otherwise switching to a mode that uses none of them leaves an empty titled card behind.
  test('is hidden itself', () => {
    const html = form(FIELDS, { values: { mode: 'button' }, sections: SECTIONS });

    expect(html).toContain('<div hidden=""><section class="form-section">');
    expect(html).toContain('>Captcha<');
  });

  test('is shown again when one of its fields is', () => {
    const html = form(FIELDS, { values: { mode: 'captcha' }, sections: SECTIONS });

    expect(html).toContain('<section class="form-section">');
    expect(html).not.toContain('<div hidden=""><section');
  });

  test('a section holding one shown field and one hidden one stays open', () => {
    const mixed = [MODE, { ...CAPTCHA_LENGTH, showWhen: { path: 'mode', equals: ['button'] } }];
    const html = form(mixed, {
      values: { mode: 'button' },
      sections: [{ id: 'general', title: 'General', fields: ['mode', 'captchaLength'] }],
    });

    expect(html).toContain(SHOWN_LENGTH);
    expect(html).not.toContain('<div hidden=""><section');
  });
});

describe('the save gate on a duration it cannot read', () => {
  const descriptors = [MODE, CAPTCHA_EXPIRY];

  test('names the setting that is holding the field off the page', () => {
    const line = unreadableLine(CAPTCHA_EXPIRY, descriptors, {
      mode: 'button',
      captchaExpiry: '5 mins',
    });

    expect(line).toContain('“Captcha expires after” is not a duration yet');
    expect(line).toContain('“How members verify” is “Solve a captcha”');
  });

  test('says nothing about a mode when the field is on screen', () => {
    const line = unreadableLine(CAPTCHA_EXPIRY, descriptors, {
      mode: 'captcha',
      captchaExpiry: '5 mins',
    });

    expect(line).toBe('“Captcha expires after” is not a duration yet.');
  });

  test('falls back to the raw option where the controller labels none of them', () => {
    const bare: FieldDescriptor = {
      kind: 'enum',
      path: 'mode',
      label: 'How members verify',
      optional: false,
      options: ['button', 'captcha', 'website'],
    };

    expect(unreadableLine(CAPTCHA_EXPIRY, [bare], { mode: 'button' })).toContain(
      '“How members verify” is “captcha”',
    );
  });
});

describe('an enum carrying option labels', () => {
  const html = form([MODE], { values: { mode: 'button' } });

  test('reads as the label, not as the schema string', () => {
    expect(html).toContain('<option value="website">Sign in on the website</option>');
  });

  test('still posts the option itself as the value', () => {
    expect(html).toContain('value="captcha"');
    expect(html).not.toContain('>captcha<');
  });

  test('falls back to a readable label, not the raw option, where no label names it', () => {
    const partial: FieldDescriptor = { ...MODE, optionLabels: { button: 'Press a button' } };

    expect(form([partial])).toContain('<option value="website">Website</option>');
    expect(form([partial])).toContain('<option value="button">Press a button</option>');
  });
});

describe('the stylesheet actually hides what the markup marks hidden', () => {
  const styles = readFileSync(join(import.meta.dir, '..', 'src', 'styles.css'), 'utf8');

  // The markup assertions above prove the attribute is written, and nothing more. `[hidden]` lives
  // in the UA sheet, so any author `display` outranks it — `.field { display: grid }` rendered every
  // showWhen-hidden row in full while carrying the attribute, and no string test could see it.
  test('declares its own [hidden] rule, because .field sets a display that outranks the browser’s', () => {
    expect(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styles)).toBe(true);
  });

  test('and every element the form marks hidden is one that rule reaches', () => {
    const marked = ['field', 'rule-param', 'rule-body', 'form-section'];

    for (const className of marked) {
      expect(`${className} is styled: ${styles.includes(`.${className}`)}`).toBe(
        `${className} is styled: true`,
      );
    }
  });
});
