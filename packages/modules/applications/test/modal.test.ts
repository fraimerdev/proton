import { describe, expect, test } from 'bun:test';
import { MAX_CUSTOM_ID_LENGTH, modalSchema } from '@proton/core';
import { ComponentType, TextInputStyle } from 'discord-api-types/v10';
import { type Question, questionSchema, type Section, sectionSchema } from '../src/config.ts';
import { INFO_RESPONSE_MAX, TEXT_ANSWER_MAX } from '../src/constants.ts';
import {
  buildRespondModal,
  buildStepModal,
  clip,
  LABEL_DESCRIPTION_MAX,
  MODAL_TITLE_MAX,
  NUMBER_INPUT_MAX,
  questionComponent,
  readResponse,
  readStepAnswers,
  stepTitle,
} from '../src/modal.ts';
import { type DraftAnswers, type Step, stepsFor, URL_ANSWER_MAX } from '../src/questions.ts';

const APP = '01J8ZQ6W3D5N4X7Y2B9C1E0F4G';

function question(input: Record<string, unknown>): Question & { sectionId: string } {
  return { ...questionSchema.parse(input), sectionId: 'main' };
}

function options(count: number): Array<{ value: string; label: string }> {
  return Array.from({ length: count }, (_, index) => ({
    value: `o${index}`,
    label: `Option ${index}`,
  }));
}

function inner(label: Record<string, unknown>): Record<string, unknown> {
  expect(label.type).toBe(ComponentType.Label);
  return label.component as Record<string, unknown>;
}

function stepOf(questions: Array<Question & { sectionId: string }>, index = 0): Step {
  return { index, sectionId: 'main', title: 'Main', description: '', questions };
}

describe('step modal components', () => {
  test('short, paragraph, number and link questions are text inputs inside a label', () => {
    const short = inner(
      questionComponent(
        question({
          id: 'name',
          type: 'short',
          label: 'Your name',
          help: 'What people call you here.',
          placeholder: 'Sam',
          maxLength: 60,
        }),
        undefined,
      ),
    );
    expect(short).toEqual({
      type: ComponentType.TextInput,
      custom_id: 'name',
      style: TextInputStyle.Short,
      required: true,
      min_length: 1,
      max_length: 60,
      placeholder: 'Sam',
    });

    const paragraph = inner(
      questionComponent(
        question({ id: 'why', type: 'paragraph', label: 'Why?', minLength: 20 }),
        'Because it matters.',
      ),
    );
    expect(paragraph).toMatchObject({
      style: TextInputStyle.Paragraph,
      min_length: 20,
      max_length: TEXT_ANSWER_MAX,
      value: 'Because it matters.',
    });

    const number = inner(
      questionComponent(question({ id: 'age', type: 'number', label: 'Age' }), undefined),
    );
    expect(number).toMatchObject({ style: TextInputStyle.Short, max_length: NUMBER_INPUT_MAX });
    expect(number.min_length).toBeUndefined();

    const url = inner(
      questionComponent(question({ id: 'site', type: 'url', label: 'Site' }), undefined),
    );
    expect(url).toMatchObject({ style: TextInputStyle.Short, max_length: URL_ANSWER_MAX });
  });

  test('help becomes the label description, clipped to Discord’s limits', () => {
    const label = questionComponent(
      question({ id: 'q', type: 'short', label: 'L'.repeat(45), help: 'h'.repeat(100) }),
      undefined,
    );
    expect(String(label.label).length).toBeLessThanOrEqual(45);
    expect(String(label.description).length).toBeLessThanOrEqual(LABEL_DESCRIPTION_MAX);

    const plain = questionComponent(
      question({ id: 'q', type: 'short', label: 'Plain' }),
      undefined,
    );
    expect(plain.description).toBeUndefined();
  });

  test('a saved answer longer than the question allows still comes back whole to be fixed', () => {
    const component = inner(
      questionComponent(
        question({ id: 'q', type: 'short', label: 'Short one', maxLength: 10 }),
        'this answer is far too long',
      ),
    );
    expect(component.value).toBe('this answer is far too long');
    expect(component.max_length).toBe('this answer is far too long'.length);
  });

  test('single choice is a radio group up to ten options and a select above that', () => {
    const radio = inner(
      questionComponent(
        question({ id: 'pick', type: 'single', label: 'Pick', options: options(3) }),
        'o1',
      ),
    );
    expect(radio.type).toBe(ComponentType.RadioGroup);
    expect(radio.required).toBe(true);
    expect(radio.options).toEqual([
      { label: 'Option 0', value: 'o0' },
      { label: 'Option 1', value: 'o1', default: true },
      { label: 'Option 2', value: 'o2' },
    ]);

    const select = inner(
      questionComponent(
        question({
          id: 'pick',
          type: 'single',
          label: 'Pick',
          required: false,
          options: options(12),
        }),
        undefined,
      ),
    );
    expect(select).toMatchObject({
      type: ComponentType.StringSelect,
      required: false,
      min_values: 0,
      max_values: 1,
    });
    expect(select.options).toHaveLength(12);
  });

  test('multiple choice is a checkbox group up to ten options and a select above that', () => {
    const group = inner(
      questionComponent(
        question({
          id: 'many',
          type: 'multiple',
          label: 'Many',
          options: options(5),
          minChoices: 2,
          maxChoices: 3,
        }),
        ['o0', 'o4'],
      ),
    );
    expect(group).toMatchObject({
      type: ComponentType.CheckboxGroup,
      required: true,
      min_values: 2,
      max_values: 3,
    });
    expect((group.options as Array<Record<string, unknown>>).filter((o) => o.default)).toEqual([
      { label: 'Option 0', value: 'o0', default: true },
      { label: 'Option 4', value: 'o4', default: true },
    ]);

    const select = inner(
      questionComponent(
        question({
          id: 'many',
          type: 'multiple',
          label: 'Many',
          options: options(25),
          maxChoices: 4,
        }),
        undefined,
      ),
    );
    expect(select).toMatchObject({
      type: ComponentType.StringSelect,
      min_values: 1,
      max_values: 4,
    });
    expect(select.options).toHaveLength(25);
  });

  test('a confirmation is a one-option checkbox group that must be ticked', () => {
    const required = inner(
      questionComponent(question({ id: 'ok', type: 'confirm', label: 'I agree' }), true),
    );
    expect(required).toEqual({
      type: ComponentType.CheckboxGroup,
      custom_id: 'ok',
      required: true,
      min_values: 1,
      max_values: 1,
      options: [{ label: 'Yes', value: 'yes', default: true }],
    });

    const optional = inner(
      questionComponent(
        question({ id: 'ok', type: 'confirm', label: 'Maybe', required: false }),
        false,
      ),
    );
    expect(optional).toMatchObject({ required: false, min_values: 0 });
    expect((optional.options as Array<Record<string, unknown>>)[0]?.default).toBeUndefined();
  });
});

describe('step modal', () => {
  const sections: Section[] = [
    sectionSchema.parse({
      id: 'main',
      title: 'Main',
      questions: Array.from({ length: 12 }, (_, index) => ({
        id: `q${index}`,
        type: 'short',
        label: `Question ${index}`,
      })),
    }),
  ];

  test('its id carries the application, step and revision, and every step fits in one modal', () => {
    const draft: DraftAnswers = { q0: 'first' };
    const steps = stepsFor(sections, draft);
    expect(steps.map((step) => step.questions.length)).toEqual([5, 5, 2]);

    for (const step of steps) {
      const modal = buildStepModal({
        applicationId: APP,
        revision: 4_294_967_295,
        draft,
        formName: 'Moderator Application',
        step,
        stepCount: steps.length,
      });
      expect(modalSchema.safeParse(modal).success).toBe(true);
      expect(modal.customId).toBe(`proton:applications:ans:${APP}:${step.index}:4294967295`);
      expect(modal.customId.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
      expect(modal.components.length).toBeLessThanOrEqual(5);
    }

    const first = steps[0] as Step;
    const built = buildStepModal({
      applicationId: APP,
      revision: 0,
      draft,
      formName: 'Moderator Application',
      step: first,
      stepCount: steps.length,
    });
    expect(built.title).toBe('Step 1 of 3 · Moderator Application');
    expect(inner(built.components[0] as Record<string, unknown>).value).toBe('first');
  });

  test('the title is the form name alone for one step, and never longer than 45', () => {
    expect(stepTitle('Moderator Application', 0, 1)).toBe('Moderator Application');
    const long = 'A form with a name that goes on for a very long while indeed';
    expect(stepTitle(long, 0, 1).length).toBeLessThanOrEqual(MODAL_TITLE_MAX);
    expect(stepTitle(long, 9, 10).length).toBeLessThanOrEqual(MODAL_TITLE_MAX);
    expect(stepTitle(long, 9, 10).startsWith('Step 10 of 10 · ')).toBe(true);
  });

  test('clip marks a cut with an ellipsis and never goes over', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
  });

  test('clip never splits an emoji, so no title ends in half of one', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

    expect(clip('ab🎮cd', 4)).toBe('ab…');
    expect(clip('🎮🎮', 1)).toBe('');

    const name = 'Staff team applications form 🎮 x';
    expect(name.charCodeAt(29)).toBe(0xd83c);
    const title = stepTitle(name, 0, 3);
    expect(title).toBe('Step 1 of 3 · Staff team applications form …');
    expect(lone.test(title)).toBe(false);
    expect(title.length).toBeLessThanOrEqual(MODAL_TITLE_MAX);
  });
});

describe('reading a submitted step', () => {
  const step = stepOf([
    question({ id: 'name', type: 'short', label: 'Name' }),
    question({ id: 'pick', type: 'single', label: 'Pick', options: options(3) }),
    question({ id: 'big', type: 'single', label: 'Big', options: options(12) }),
    question({ id: 'many', type: 'multiple', label: 'Many', options: options(4) }),
    question({ id: 'ok', type: 'confirm', label: 'OK' }),
  ]);

  test('each answer is read from where Discord puts it', () => {
    expect(
      readStepAnswers(step, {
        fields: { name: 'Sam', pick: 'o2' },
        values: { big: ['o11'], many: ['o1', 'o3', 'o1'], ok: ['yes'] },
        checks: {},
      }),
    ).toEqual({ name: 'Sam', pick: 'o2', big: 'o11', many: ['o1', 'o3'], ok: true });
  });

  test('an empty answer replaces the saved one rather than keeping it', () => {
    expect(readStepAnswers(step, { fields: {}, values: {}, checks: {} })).toEqual({
      name: '',
      pick: '',
      big: '',
      many: [],
      ok: false,
    });
  });

  test('a lone checkbox, stray keys and oversized values are handled', () => {
    const read = readStepAnswers(step, {
      fields: { name: 'x'.repeat(5000), other: 'ignored' },
      values: { many: ['o1', 'y'.repeat(40)] },
      checks: { ok: true },
    });
    expect(read.name).toHaveLength(TEXT_ANSWER_MAX);
    expect(read.many).toEqual(['o1']);
    expect(read.ok).toBe(true);
    expect(Object.hasOwn(read, 'other')).toBe(false);
  });
});

describe('answering staff', () => {
  test('the answer window is one required paragraph with the revision in its id', () => {
    const modal = buildRespondModal({
      applicationId: APP,
      revision: 7,
      formName: 'Moderator Application',
    });
    expect(modalSchema.safeParse(modal).success).toBe(true);
    expect(modal.customId).toBe(`proton:applications:respm:${APP}:7`);
    expect(modal.title.length).toBeLessThanOrEqual(MODAL_TITLE_MAX);
    expect(inner(modal.components[0] as Record<string, unknown>)).toMatchObject({
      type: ComponentType.TextInput,
      style: TextInputStyle.Paragraph,
      required: true,
      max_length: INFO_RESPONSE_MAX,
    });
  });

  test('the answer is trimmed and its line endings made plain', () => {
    expect(readResponse({ fields: { response: '  one\r\ntwo\r\n ' } })).toBe('one\ntwo');
    expect(readResponse({ fields: {} })).toBe('');
  });
});
