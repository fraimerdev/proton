import { describe, expect, test } from 'bun:test';
import { type Question, questionSchema } from '@proton/module-applications/config';
import { TEXT_ANSWER_MAX } from '@proton/module-applications/constants';
import type { RawAnswer } from '@proton/module-applications/questions';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  choiceHint,
  inputModeOf,
  lengthHint,
  numberHint,
  QuestionInput,
  questionAnchor,
  segmentedFits,
  urlHint,
} from '../src/pages/apply/question-input.tsx';

type QuestionInit = Partial<Omit<Question, 'options'>> & {
  id: string;
  type: Question['type'];
  options?: { value: string; label: string; description?: string }[];
};

function question(init: QuestionInit): Question {
  return questionSchema.parse({ label: 'Tell us about you', ...init });
}

function render(target: Question, value?: RawAnswer, error?: string): string {
  return renderToStaticMarkup(
    <QuestionInput
      question={target}
      value={value}
      error={error}
      onChange={() => undefined}
      onBlur={() => undefined}
    />,
  );
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

const ROLES = [
  { value: 'mod', label: 'Moderator' },
  { value: 'dev', label: 'Developer' },
  { value: 'art', label: 'Artist' },
];

const MANY = [
  ...ROLES,
  { value: 'event', label: 'Event host' },
  { value: 'writer', label: 'Writer' },
  { value: 'other', label: 'Something else', description: 'Tell us in the next question.' },
];

describe('text questions', () => {
  test('short answers are a single-line field capped at their limit', () => {
    const markup = render(question({ id: 'name', type: 'short', maxLength: 80 }), 'Ana');

    expect(markup).toContain('<input');
    expect(markup).toMatch(/inputmode="text"/i);
    expect(markup).toMatch(/maxlength="80"/i);
    expect(markup).toContain('value="Ana"');
    expect(markup).toContain('Up to 80 characters.');
    expect(markup).toContain(`for="${questionAnchor('name')}-control"`);
    expect(markup).toContain(`id="${questionAnchor('name')}-control"`);
  });

  test('paragraphs are a text area with a live character count', () => {
    const markup = render(
      question({ id: 'why', type: 'paragraph', maxLength: 300, minLength: 20 }),
      'Because I care',
    );

    expect(markup).toContain('<textarea');
    expect(markup).toMatch(/maxlength="300"/i);
    expect(markup).toContain('14 / 300');
    expect(markup).toContain('At least 20 characters.');
  });

  test('a paragraph with no limit counts against the most Proton stores', () => {
    expect(render(question({ id: 'why', type: 'paragraph' }))).toContain('0 / 4000');
  });

  test('numbers ask for the keypad that fits their range', () => {
    const whole = question({ id: 'age', type: 'number', integer: true, min: 13, max: 99 });
    const decimal = question({ id: 'hours', type: 'number', min: 0 });
    const signed = question({ id: 'offset', type: 'number', min: -12, max: 14 });

    expect(render(whole)).toMatch(/inputmode="numeric"/i);
    expect(render(decimal)).toMatch(/inputmode="decimal"/i);
    expect(render(signed)).toMatch(/inputmode="text"/i);
    expect(inputModeOf(question({ id: 'any', type: 'number' }))).toBe('text');
    expect(render(whole)).toContain('A whole number from 13 to 99.');
  });

  test('links are a url field that names the sites it accepts', () => {
    const markup = render(
      question({ id: 'site', type: 'url', hosts: ['github.com', 'gitlab.com'] }),
    );

    expect(markup).toContain('type="url"');
    expect(markup).toMatch(/inputmode="url"/i);
    expect(markup).toContain('A link to github.com or gitlab.com.');
  });

  test('links and numbers stop at the most Proton stores, so a long paste never fails to save', () => {
    const cap = new RegExp(`maxlength="${TEXT_ANSWER_MAX}"`, 'i');

    expect(render(question({ id: 'site', type: 'url' }))).toMatch(cap);
    expect(render(question({ id: 'age', type: 'number', integer: true }))).toMatch(cap);
  });
});

describe('choice questions', () => {
  test('a few short options become a segmented choice', () => {
    const target = question({ id: 'role', type: 'single', options: ROLES });
    const markup = render(target, 'dev');

    expect(segmentedFits(target)).toBe(true);
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('class="segmented block"');
    expect(count(markup, 'role="radio"')).toBe(3);
    expect(count(markup, 'aria-checked="true"')).toBe(1);
    expect(markup).toContain('aria-label="Tell us about you (required)"');
  });

  test('longer lists are native radio buttons, descriptions included', () => {
    const target = question({ id: 'role', type: 'single', options: MANY });
    const markup = render(target, 'other');

    expect(segmentedFits(target)).toBe(false);
    expect(count(markup, 'type="radio"')).toBe(6);
    expect(count(markup, `name="${questionAnchor('role')}"`)).toBe(6);
    expect(count(markup, 'checked=""')).toBe(1);
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-required="true"');
    expect(markup).toContain('Tell us in the next question.');
  });

  test('a description or a long label keeps the list form', () => {
    expect(
      segmentedFits(
        question({
          id: 'a',
          type: 'single',
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No', description: 'We will ask why next.' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      segmentedFits(
        question({
          id: 'b',
          type: 'single',
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No, but I would like to learn how' },
          ],
        }),
      ),
    ).toBe(false);
  });

  test('an optional choice can be cleared, a required one cannot', () => {
    const optional = question({ id: 'role', type: 'single', options: ROLES, required: false });

    expect(render(optional, 'mod')).toContain('Clear answer');
    expect(render(optional)).not.toContain('Clear answer');
    expect(render(question({ id: 'role', type: 'single', options: ROLES }), 'mod')).not.toContain(
      'Clear answer',
    );
  });

  test('multiple choice is a checkbox list that says how many to pick', () => {
    const markup = render(
      question({ id: 'skills', type: 'multiple', options: MANY, maxChoices: 2 }),
      ['dev', 'art'],
    );

    expect(count(markup, 'type="checkbox"')).toBe(6);
    expect(count(markup, 'checked=""')).toBe(2);
    expect(markup).toContain('<fieldset');
    expect(markup).toContain(`aria-labelledby="${questionAnchor('skills')}-label"`);
    expect(markup).toContain('Choose up to 2.');
    expect(markup).toContain('Tell us in the next question.');
  });

  test('choice hints read naturally for every range', () => {
    expect(choiceHint({ minChoices: 2, maxChoices: 4 })).toBe('Choose 2 to 4.');
    expect(choiceHint({ minChoices: 2, maxChoices: 2 })).toBe('Choose exactly 2.');
    expect(choiceHint({ minChoices: 1, maxChoices: undefined })).toBe('Choose at least 1.');
    expect(choiceHint({ minChoices: undefined, maxChoices: undefined })).toBe(
      'Choose any that apply.',
    );
  });

  test('a confirmation is one checkbox named by its statement', () => {
    const target = question({
      id: 'rules',
      type: 'confirm',
      label: 'I have read the rules',
      help: 'They are pinned in #welcome.',
    });

    const markup = render(target, true);
    expect(count(markup, 'type="checkbox"')).toBe(1);
    expect(count(markup, 'checked=""')).toBe(1);
    expect(markup).toContain('aria-required="true"');
    expect(markup).toMatch(/<label[^>]*>.*I have read the rules.*<\/label>/);
    expect(markup).toContain(`aria-describedby="${questionAnchor('rules')}-help"`);
    expect(markup).toContain('They are pinned in #welcome.');
    expect(render(target)).not.toContain('checked=""');
  });
});

describe('every question', () => {
  test('marks required questions and leaves optional ones plain', () => {
    expect(render(question({ id: 'name', type: 'short' }))).toContain('apply-required');
    expect(render(question({ id: 'name', type: 'short' }))).toContain('aria-required="true"');

    const optional = render(question({ id: 'name', type: 'short', required: false }));
    expect(optional).not.toContain('apply-required');
    expect(optional).not.toContain('aria-required');
  });

  test('shows help and a problem next to the field, tied to it for screen readers', () => {
    const markup = render(
      question({ id: 'site', type: 'url', help: 'Your portfolio or GitHub.' }),
      'not a link',
      'Enter a link that starts with https://.',
    );
    const base = questionAnchor('site');

    expect(markup).toContain(`id="${base}"`);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(`aria-describedby="${base}-help ${base}-error"`);
    expect(markup).toContain('Your portfolio or GitHub.');
    expect(markup).toContain('Enter a link that starts with https://.');
  });

  test('hints stay quiet when there is nothing to say', () => {
    expect(lengthHint({ type: 'short', minLength: undefined, maxLength: undefined })).toBeNull();
    expect(numberHint({ min: undefined, max: undefined, integer: false })).toBeNull();
    expect(urlHint({ schemes: ['https'], hosts: [] })).toBeNull();
    expect(urlHint({ schemes: ['http'], hosts: [] })).toBe('A link that starts with http://.');
  });

  test('no copy an applicant reads has an em dash', () => {
    const everything = [
      render(question({ id: 'a', type: 'short', maxLength: 20, minLength: 2 })),
      render(question({ id: 'b', type: 'paragraph', minLength: 5 })),
      render(question({ id: 'c', type: 'number', integer: true, min: 1 })),
      render(question({ id: 'd', type: 'single', options: MANY, required: false }), 'dev'),
      render(question({ id: 'e', type: 'multiple', options: ROLES, minChoices: 1, maxChoices: 2 })),
      render(question({ id: 'f', type: 'confirm' })),
    ].join('');

    expect(everything).not.toContain('—');
  });
});
