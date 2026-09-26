import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
  type FlatQuestion,
  type Question,
  questionSchema,
  type Section,
  sectionSchema,
} from '../src/config.ts';
import { QUESTIONS_PER_STEP, TEXT_ANSWER_MAX } from '../src/constants.ts';
import {
  checkAnswer,
  checkAnswers,
  displayAnswer,
  draftAnswersSchema,
  isVisible,
  normaliseUrl,
  parseNumber,
  pruneHidden,
  stepsFor,
  URL_ANSWER_MAX,
  visibleQuestions,
} from '../src/questions.ts';

type QuestionInput = z.input<typeof questionSchema>;
type SectionInput = z.input<typeof sectionSchema>;

function question(input: QuestionInput): Question {
  return questionSchema.parse(input);
}

function sections(...list: SectionInput[]): Section[] {
  return list.map((section) => sectionSchema.parse(section));
}

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const COLOURS = [
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'amber', label: 'Amber' },
];

const ROLE = question({
  id: 'role',
  type: 'single',
  label: 'Role',
  options: [
    { value: 'developer', label: 'Developer' },
    { value: 'designer', label: 'Designer' },
  ],
});

function ids(list: readonly { id: string }[]): string[] {
  return list.map((entry) => entry.id);
}

describe('draftAnswersSchema', () => {
  test('it holds text, choice lists and confirmations keyed by question id', () => {
    const answers = { name: 'Ada', role_2: ['a', 'b'], rules: true };
    expect(draftAnswersSchema.parse(answers)).toEqual(answers);
  });

  test('it refuses keys that could never be a question id', () => {
    for (const key of ['Name', '-name', '_name', 'has space', 'a'.repeat(33)]) {
      expect(draftAnswersSchema.safeParse({ [key]: 'x' }).success).toBe(false);
    }
  });

  test('a __proto__ key from JSON never reaches the stored draft', () => {
    const parsed = draftAnswersSchema.parse(JSON.parse('{"__proto__": "x", "name": "Ada"}'));
    expect(Object.keys(parsed)).toEqual(['name']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  test('it refuses oversized answers instead of trimming them', () => {
    expect(draftAnswersSchema.safeParse({ why: 'x'.repeat(TEXT_ANSWER_MAX) }).success).toBe(true);
    expect(draftAnswersSchema.safeParse({ why: 'x'.repeat(TEXT_ANSWER_MAX + 1) }).success).toBe(
      false,
    );
    expect(
      draftAnswersSchema.safeParse({ pick: Array.from({ length: 26 }, () => 'a') }).success,
    ).toBe(false);
    expect(draftAnswersSchema.safeParse({ pick: ['a'.repeat(33)] }).success).toBe(false);
    expect(draftAnswersSchema.safeParse({ pick: [''] }).success).toBe(false);
    expect(draftAnswersSchema.safeParse({ count: 3 }).success).toBe(false);
  });

  test('a draft holds at most as many answers as a form has questions', () => {
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`q${index}`, 'x']));

    expect(draftAnswersSchema.safeParse(many(50)).success).toBe(true);
    expect(draftAnswersSchema.safeParse(many(51)).success).toBe(false);
  });
});

describe('parseNumber', () => {
  const whole = { min: 1, max: 10, integer: true };

  test('it reads whole numbers in range', () => {
    expect(parseNumber(' 7 ', whole)).toEqual({ ok: true, value: 7 });
    expect(parseNumber('1', whole)).toEqual({ ok: true, value: 1 });
    expect(parseNumber('10', whole)).toEqual({ ok: true, value: 10 });
    expect(parseNumber('+4', whole)).toEqual({ ok: true, value: 4 });
  });

  test('it says what it wants when the answer is out of range or not a whole number', () => {
    const refusal = { ok: false, message: 'Enter a whole number from 1 to 10.' } as const;

    for (const raw of ['0', '11', '1.5', 'seven', '', '1e3', '0x10', 'Infinity', 'NaN', '5 5']) {
      expect(parseNumber(raw, whole)).toEqual(refusal);
    }
  });

  test('decimals are fine unless the question wants whole numbers', () => {
    const any = { integer: false };

    expect(parseNumber('2.5', any)).toEqual({ ok: true, value: 2.5 });
    expect(parseNumber('.5', any)).toEqual({ ok: true, value: 0.5 });
    expect(parseNumber('-3', any)).toEqual({ ok: true, value: -3 });
    expect(parseNumber('2.5', { integer: true })).toEqual({
      ok: false,
      message: 'Enter a whole number.',
    });
  });

  test('the message follows whichever limits are set', () => {
    expect(parseNumber('x', { min: 0, integer: false })).toEqual({
      ok: false,
      message: 'Enter a number of 0 or more.',
    });
    expect(parseNumber('x', { max: 99.5, integer: false })).toEqual({
      ok: false,
      message: 'Enter a number of 99.5 or less.',
    });
    expect(parseNumber('x', { integer: false })).toEqual({ ok: false, message: 'Enter a number.' });
  });

  test('a very long run of digits is refused rather than rounded', () => {
    expect(parseNumber('9'.repeat(41), { integer: true }).ok).toBe(false);
  });
});

describe('normaliseUrl', () => {
  const https = ['https'] as const;

  test('a bare domain gets https:// and the result is normalised', () => {
    expect(normaliseUrl('github.com/me', https, [])).toEqual({
      ok: true,
      url: 'https://github.com/me',
    });
    expect(normaliseUrl('  HTTPS://GitHub.COM/Me ', https, [])).toEqual({
      ok: true,
      url: 'https://github.com/Me',
    });
    expect(normaliseUrl('example.com:8080/path', https, [])).toEqual({
      ok: true,
      url: 'https://example.com:8080/path',
    });
  });

  test('only the schemes the question allows get through', () => {
    const wanted = { ok: false, message: 'Enter a link that starts with https://.' } as const;

    expect(normaliseUrl('http://example.com', https, [])).toEqual(wanted);
    expect(normaliseUrl('javascript:alert(1)', https, [])).toEqual(wanted);
    expect(normaliseUrl('mailto:me@example.com', https, [])).toEqual(wanted);
    expect(normaliseUrl('data:text/html,hi', https, [])).toEqual(wanted);
    expect(normaliseUrl('ftp://example.com', https, [])).toEqual(wanted);

    expect(normaliseUrl('http://example.com', ['https', 'http'], [])).toEqual({
      ok: true,
      url: 'http://example.com/',
    });
    expect(normaliseUrl('ftp://example.com', ['http', 'https'], [])).toEqual({
      ok: false,
      message: 'Enter a link that starts with https:// or http://.',
    });
  });

  test('an http-only question adds http:// to a bare domain', () => {
    expect(normaliseUrl('example.com', ['http'], [])).toEqual({
      ok: true,
      url: 'http://example.com/',
    });
  });

  test('it refuses links that are not full web addresses', () => {
    expect(normaliseUrl('', https, [])).toEqual({
      ok: false,
      message: 'Enter a link that starts with https://.',
    });
    expect(normaliseUrl('https://exa mple.com', https, []).ok).toBe(false);
    expect(normaliseUrl('localhost', https, [])).toEqual({
      ok: false,
      message: 'Enter a full link, like https://example.com.',
    });
    expect(normaliseUrl('https://[::1]/', https, []).ok).toBe(false);
    expect(normaliseUrl('https://user:secret@example.com', https, [])).toEqual({
      ok: false,
      message: 'Enter a link without a username or password in it.',
    });
  });

  test('a host list allows those domains and their subdomains only', () => {
    const hosts = ['github.com'];

    expect(normaliseUrl('https://github.com/me', https, hosts).ok).toBe(true);
    expect(normaliseUrl('gist.github.com/me', https, hosts).ok).toBe(true);
    expect(normaliseUrl('https://GITHUB.com.', https, hosts).ok).toBe(true);

    for (const raw of ['https://evilgithub.com', 'https://github.com.evil.io', 'gitlab.com']) {
      expect(normaliseUrl(raw, https, hosts)).toEqual({
        ok: false,
        message: 'Enter a link to github.com.',
      });
    }

    expect(normaliseUrl('gitlab.com', https, ['discord.gg', 'discord.com', 'x.com'])).toEqual({
      ok: false,
      message: 'Enter a link to discord.gg, discord.com or x.com.',
    });
  });

  test('an over-long link is refused, not cut', () => {
    const base = 'https://example.com/';
    const fits = `${base}${'a'.repeat(URL_ANSWER_MAX - base.length)}`;

    expect(normaliseUrl(fits, https, [])).toEqual({ ok: true, url: fits });
    expect(normaliseUrl(`${fits}a`, https, [])).toEqual({
      ok: false,
      message: `Use a link of ${URL_ANSWER_MAX} characters or fewer.`,
    });
  });
});

describe('checkAnswer', () => {
  test('text is trimmed and length limits refuse rather than cut', () => {
    const short = question({
      id: 'name',
      type: 'short',
      label: 'Name',
      minLength: 2,
      maxLength: 5,
    });

    expect(checkAnswer(short, '  Ada  ')).toEqual({ ok: true, value: 'Ada', display: 'Ada' });
    expect(checkAnswer(short, 'Ada Lovelace')).toEqual({
      ok: false,
      message: 'Use 5 characters or fewer. This answer has 12.',
    });
    expect(checkAnswer(short, 'A')).toEqual({
      ok: false,
      message: 'Use at least 2 characters. This answer has 1.',
    });
  });

  test('without a maximum, text still stops at the storage limit', () => {
    const long = question({ id: 'why', type: 'paragraph', label: 'Why' });

    expect(checkAnswer(long, 'x'.repeat(TEXT_ANSWER_MAX)).ok).toBe(true);
    expect(checkAnswer(long, 'x'.repeat(TEXT_ANSWER_MAX + 1))).toEqual({
      ok: false,
      message: `Use ${TEXT_ANSWER_MAX} characters or fewer. This answer has ${TEXT_ANSWER_MAX + 1}.`,
    });
  });

  test('a paragraph keeps its line breaks, with Windows line endings folded', () => {
    const long = question({ id: 'why', type: 'paragraph', label: 'Why' });
    expect(checkAnswer(long, 'one\r\ntwo\rthree\n')).toEqual({
      ok: true,
      value: 'one\ntwo\nthree',
      display: 'one\ntwo\nthree',
    });
  });

  test('an empty or missing answer is empty, whatever the type', () => {
    const empty = { ok: true, value: null, display: '' } as const;
    const types = [
      question({ id: 'a', type: 'short', label: 'A' }),
      question({ id: 'b', type: 'number', label: 'B' }),
      question({ id: 'c', type: 'url', label: 'C' }),
      question({ id: 'd', type: 'single', label: 'D', options: YES_NO }),
      question({ id: 'e', type: 'multiple', label: 'E', options: YES_NO }),
      question({ id: 'f', type: 'confirm', label: 'F' }),
    ];

    for (const item of types) {
      expect(checkAnswer(item, undefined)).toEqual(empty);
    }
    expect(checkAnswer(types[0] as Question, '   ')).toEqual(empty);
    expect(checkAnswer(types[3] as Question, '')).toEqual(empty);
    expect(checkAnswer(types[4] as Question, [])).toEqual(empty);
  });

  test('a text question refuses a list or a checkbox', () => {
    const short = question({ id: 'name', type: 'short', label: 'Name' });
    expect(checkAnswer(short, ['a'])).toEqual({ ok: false, message: 'Answer this with text.' });
    expect(checkAnswer(short, true)).toEqual({ ok: false, message: 'Answer this with text.' });
  });

  test('a number is stored as the trimmed text the member typed', () => {
    const hours = question({
      id: 'hours',
      type: 'number',
      label: 'Hours',
      integer: true,
      min: 1,
      max: 80,
    });

    expect(checkAnswer(hours, ' 12 ')).toEqual({ ok: true, value: '12', display: '12' });
    expect(checkAnswer(hours, '120')).toEqual({
      ok: false,
      message: 'Enter a whole number from 1 to 80.',
    });
    expect(checkAnswer(hours, ['12'])).toEqual({
      ok: false,
      message: 'Enter a whole number from 1 to 80.',
    });
  });

  test('a link is stored normalised', () => {
    const site = question({ id: 'site', type: 'url', label: 'Site' });

    expect(checkAnswer(site, 'github.com/ada')).toEqual({
      ok: true,
      value: 'https://github.com/ada',
      display: 'https://github.com/ada',
    });
    expect(checkAnswer(site, 'http://github.com')).toEqual({
      ok: false,
      message: 'Enter a link that starts with https://.',
    });
  });

  test('a single choice stores the option value and shows its label', () => {
    expect(checkAnswer(ROLE, 'designer')).toEqual({
      ok: true,
      value: 'designer',
      display: 'Designer',
    });
    expect(checkAnswer(ROLE, ['developer'])).toEqual({
      ok: true,
      value: 'developer',
      display: 'Developer',
    });
    expect(checkAnswer(ROLE, 'writer')).toEqual({
      ok: false,
      message: 'Choose one of the options.',
    });
    expect(checkAnswer(ROLE, ['developer', 'designer'])).toEqual({
      ok: false,
      message: 'Choose only one option.',
    });
    expect(checkAnswer(ROLE, true)).toEqual({ ok: false, message: 'Choose one of the options.' });
  });

  test('a multiple choice keeps option order, drops repeats and checks the count', () => {
    const colours = question({
      id: 'colours',
      type: 'multiple',
      label: 'Colours',
      options: COLOURS,
      minChoices: 2,
      maxChoices: 3,
    });

    expect(checkAnswer(colours, ['blue', 'red', 'blue'])).toEqual({
      ok: true,
      value: ['red', 'blue'],
      display: 'Red, Blue',
    });
    expect(checkAnswer(colours, ['red'])).toEqual({ ok: false, message: 'Choose from 2 to 3.' });
    expect(checkAnswer(colours, ['red', 'green', 'blue', 'amber'])).toEqual({
      ok: false,
      message: 'Choose from 2 to 3.',
    });
    expect(checkAnswer(colours, ['red', 'pink'])).toEqual({
      ok: false,
      message: 'Choose from the options given.',
    });
    expect(checkAnswer(colours, false)).toEqual({
      ok: false,
      message: 'Choose from the options given.',
    });
  });

  test('choice count messages read naturally', () => {
    const at = (minChoices?: number, maxChoices?: number) =>
      question({
        id: 'colours',
        type: 'multiple',
        label: 'Colours',
        options: COLOURS,
        ...(minChoices === undefined ? {} : { minChoices }),
        ...(maxChoices === undefined ? {} : { maxChoices }),
      });

    expect(checkAnswer(at(undefined, 1), ['red', 'blue'])).toEqual({
      ok: false,
      message: 'Choose at most 1.',
    });
    expect(checkAnswer(at(3), ['red'])).toEqual({ ok: false, message: 'Choose at least 3.' });
    expect(checkAnswer(at(2, 2), ['red'])).toEqual({ ok: false, message: 'Choose exactly 2.' });
    expect(checkAnswer(at(), 'red')).toEqual({ ok: true, value: ['red'], display: 'Red' });
  });

  test('a confirmation accepts every shape a tick arrives in and stores true', () => {
    const rules = question({ id: 'rules', type: 'confirm', label: 'I read the rules' });
    const ticked = { ok: true, value: true, display: 'Confirmed' } as const;

    expect(checkAnswer(rules, true)).toEqual(ticked);
    expect(checkAnswer(rules, 'yes')).toEqual(ticked);
    expect(checkAnswer(rules, ['yes'])).toEqual(ticked);
    expect(checkAnswer(rules, false)).toEqual({ ok: true, value: null, display: '' });
    expect(checkAnswer(rules, 'no')).toEqual({ ok: true, value: null, display: '' });
  });
});

describe('displayAnswer', () => {
  test('choices show labels, a confirmation shows Confirmed, text shows itself', () => {
    const colours = question({ id: 'c', type: 'multiple', label: 'C', options: COLOURS });

    expect(displayAnswer(colours, ['red', 'amber'])).toBe('Red, Amber');
    expect(displayAnswer(colours, ['gone'])).toBe('gone');
    expect(displayAnswer(ROLE, 'developer')).toBe('Developer');
    expect(displayAnswer({ type: 'confirm', options: [] }, true)).toBe('Confirmed');
    expect(displayAnswer({ type: 'short', options: [] }, 'Hello')).toBe('Hello');
    expect(displayAnswer({ type: 'short', options: [] }, null)).toBe('');
  });
});

const BRANCHING = sections(
  {
    id: 'one',
    questions: [
      { id: 'role', type: 'single', label: 'Role', options: ROLE.options },
      {
        id: 'portfolio',
        type: 'url',
        label: 'Portfolio',
        showIf: { questionId: 'role', values: ['developer'] },
      },
      {
        id: 'public',
        type: 'single',
        label: 'Is it public?',
        options: YES_NO,
        showIf: { questionId: 'role', values: ['developer'] },
      },
    ],
  },
  {
    id: 'two',
    questions: [
      {
        id: 'repo',
        type: 'short',
        label: 'Repository name',
        showIf: { questionId: 'public', values: ['yes'] },
      },
      { id: 'agree', type: 'confirm', label: 'I agree' },
      {
        id: 'thanks',
        type: 'short',
        label: 'Anything else?',
        required: false,
        showIf: { questionId: 'agree', values: ['yes'] },
      },
      {
        id: 'colours',
        type: 'multiple',
        label: 'Colours',
        options: COLOURS,
        required: false,
      },
      {
        id: 'why-blue',
        type: 'short',
        label: 'Why blue?',
        showIf: { questionId: 'colours', values: ['blue', 'amber'] },
      },
    ],
  },
);

function lookup(list: readonly Section[]): Map<string, FlatQuestion> {
  return new Map(
    list.flatMap((section) =>
      section.questions.map((item) => [item.id, { ...item, sectionId: section.id }] as const),
    ),
  );
}

describe('visibility', () => {
  const byId = lookup(BRANCHING);
  const visible = (answers: Record<string, string | string[] | boolean>) =>
    ids(visibleQuestions(BRANCHING, answers));

  test('a question shows when its source has one of the listed answers', () => {
    expect(visible({})).toEqual(['role', 'agree', 'colours']);
    expect(visible({ role: 'developer' })).toEqual([
      'role',
      'portfolio',
      'public',
      'agree',
      'colours',
    ]);
    expect(visible({ role: 'designer' })).toEqual(['role', 'agree', 'colours']);
  });

  test('hiding a source hides everything that depends on it, even with answers left behind', () => {
    const stale = { role: 'designer', public: 'yes', repo: 'proton' };
    expect(visible(stale)).toEqual(['role', 'agree', 'colours']);

    const repo = byId.get('repo');
    if (repo === undefined) throw new Error('missing question');
    expect(isVisible(repo, stale, byId)).toBe(false);
    expect(isVisible(repo, { ...stale, role: 'developer' }, byId)).toBe(true);
  });

  test('a multiple choice source matches when any listed option is picked', () => {
    expect(visible({ colours: ['red'] })).not.toContain('why-blue');
    expect(visible({ colours: ['red', 'amber'] })).toContain('why-blue');
  });

  test('a confirmation source matches when ticked', () => {
    expect(visible({ agree: false })).not.toContain('thanks');
    expect(visible({ agree: true })).toContain('thanks');
    expect(visible({ agree: ['yes'] })).toContain('thanks');
  });

  test('a question whose source is missing stays hidden', () => {
    const orphan = { id: 'orphan', showIf: { questionId: 'gone', values: ['a'] } };
    expect(isVisible(orphan, { gone: 'a' }, byId)).toBe(false);
  });

  test('an answer the source would refuse reveals nothing', () => {
    expect(visible({ role: 'writer' })).toEqual(['role', 'agree', 'colours']);
    expect(visible({ role: ['developer', 'designer'] })).toEqual(['role', 'agree', 'colours']);
    expect(visible({ colours: ['blue', 'pink'] })).not.toContain('why-blue');
    expect(visible({ agree: 'maybe' })).not.toContain('thanks');
  });

  test('a cycle that slipped past validation hides the questions instead of looping', () => {
    const first = question({
      id: 'first',
      type: 'single',
      label: 'First',
      options: YES_NO,
      showIf: { questionId: 'second', values: ['yes'] },
    });
    const second = question({
      id: 'second',
      type: 'single',
      label: 'Second',
      options: YES_NO,
      showIf: { questionId: 'first', values: ['yes'] },
    });
    const looped = new Map([
      ['first', first],
      ['second', second],
    ]);

    expect(isVisible(first, { first: 'yes', second: 'yes' }, looped)).toBe(false);
    expect(isVisible(second, { first: 'yes', second: 'yes' }, looped)).toBe(false);
  });
});

describe('checkAnswers', () => {
  const complete = {
    role: 'developer',
    portfolio: 'github.com/ada',
    public: 'no',
    agree: true,
  };

  test('a complete application passes and lists answers in document order', () => {
    const result = checkAnswers(BRANCHING, complete, { partial: false });

    expect(result).toEqual({
      ok: true,
      answers: [
        {
          questionId: 'role',
          sectionId: 'one',
          label: 'Role',
          type: 'single',
          value: 'developer',
          display: 'Developer',
        },
        {
          questionId: 'portfolio',
          sectionId: 'one',
          label: 'Portfolio',
          type: 'url',
          value: 'https://github.com/ada',
          display: 'https://github.com/ada',
        },
        {
          questionId: 'public',
          sectionId: 'one',
          label: 'Is it public?',
          type: 'single',
          value: 'no',
          display: 'No',
        },
        {
          questionId: 'agree',
          sectionId: 'two',
          label: 'I agree',
          type: 'confirm',
          value: true,
          display: 'Confirmed',
        },
      ],
    });
  });

  test('a hidden required question never blocks, and its leftover answer is dropped', () => {
    const result = checkAnswers(
      BRANCHING,
      { role: 'designer', portfolio: 'not a link', repo: '', agree: true },
      { partial: false },
    );

    expect(result.ok).toBe(true);
    expect(result.answers.map(({ questionId }) => questionId)).toEqual(['role', 'agree']);
  });

  test('a visible required question with no answer is a problem, unless the check is partial', () => {
    const answers = { role: 'developer' };
    const full = checkAnswers(BRANCHING, answers, { partial: false });

    expect(full).toEqual({
      ok: false,
      problems: [
        { questionId: 'portfolio', label: 'Portfolio', message: '“Portfolio” needs an answer.' },
        {
          questionId: 'public',
          label: 'Is it public?',
          message: '“Is it public?” needs an answer.',
        },
        { questionId: 'agree', label: 'I agree', message: '“I agree” needs an answer.' },
      ],
      answers: [
        {
          questionId: 'role',
          sectionId: 'one',
          label: 'Role',
          type: 'single',
          value: 'developer',
          display: 'Developer',
        },
      ],
    });

    expect(checkAnswers(BRANCHING, answers, { partial: true }).ok).toBe(true);
  });

  test('an invalid answer is a problem even in a partial check', () => {
    const result = checkAnswers(
      BRANCHING,
      { role: 'developer', portfolio: 'ftp://files.example.com' },
      { partial: true },
    );

    expect(result).toEqual({
      ok: false,
      problems: [
        {
          questionId: 'portfolio',
          label: 'Portfolio',
          message: 'Enter a link that starts with https://.',
        },
      ],
      answers: [
        {
          questionId: 'role',
          sectionId: 'one',
          label: 'Role',
          type: 'single',
          value: 'developer',
          display: 'Developer',
        },
      ],
    });
  });

  test('answers for questions the form does not have are ignored', () => {
    const result = checkAnswers(BRANCHING, { ...complete, stray: 'x' }, { partial: false });
    expect(result.ok).toBe(true);
    expect(result.answers.some(({ questionId }) => questionId === 'stray')).toBe(false);
  });

  test('an optional question left empty is simply absent', () => {
    const result = checkAnswers(BRANCHING, { ...complete, colours: [] }, { partial: false });
    expect(result.ok).toBe(true);
    expect(result.answers.some(({ questionId }) => questionId === 'colours')).toBe(false);
  });
});

describe('pruneHidden', () => {
  test('it keeps visible answers and drops hidden or unknown ones', () => {
    expect(
      pruneHidden(BRANCHING, {
        role: 'designer',
        portfolio: 'github.com',
        repo: 'x',
        agree: true,
        stray: 'y',
      }),
    ).toEqual({ role: 'designer', agree: true });
  });
});

function manyQuestions(prefix: string, count: number): QuestionInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    type: 'short' as const,
    label: `Question ${index}`,
  }));
}

describe('stepsFor', () => {
  test(`a section is cut into steps of at most ${QUESTIONS_PER_STEP}`, () => {
    const form = sections(
      { id: 'long', title: 'Long', description: 'Lots', questions: manyQuestions('a', 12) },
      { id: 'short', title: 'Short', questions: manyQuestions('b', 2) },
    );

    const steps = stepsFor(form, {});
    expect(steps.map((step) => [step.index, step.sectionId, step.questions.length])).toEqual([
      [0, 'long', 5],
      [1, 'long', 5],
      [2, 'long', 2],
      [3, 'short', 2],
    ]);
    expect(steps[0]?.title).toBe('Long');
    expect(steps[0]?.description).toBe('Lots');
    expect(steps[3]?.title).toBe('Short');
  });

  test('a question starts a new step when its source is in the step so far', () => {
    const steps = stepsFor(BRANCHING, { role: 'developer', public: 'yes', agree: true });

    expect(steps.map((step) => ids(step.questions))).toEqual([
      ['role'],
      ['portfolio', 'public'],
      ['repo', 'agree'],
      ['thanks', 'colours'],
    ]);
  });

  test('hidden questions leave no empty steps and the indices stay contiguous', () => {
    const steps = stepsFor(BRANCHING, { role: 'designer' });

    expect(steps.map((step) => [step.index, ids(step.questions)])).toEqual([
      [0, ['role']],
      [1, ['agree']],
      [2, ['colours']],
    ]);
  });

  test('a source in an earlier section does not split the later one', () => {
    const form = sections(
      {
        id: 'one',
        questions: [{ id: 'role', type: 'single', label: 'Role', options: ROLE.options }],
      },
      {
        id: 'two',
        questions: [
          { id: 'name', type: 'short', label: 'Name' },
          {
            id: 'portfolio',
            type: 'url',
            label: 'Portfolio',
            showIf: { questionId: 'role', values: ['developer'] },
          },
        ],
      },
    );

    expect(stepsFor(form, { role: 'developer' }).map((step) => ids(step.questions))).toEqual([
      ['role'],
      ['name', 'portfolio'],
    ]);
  });

  test('answering a step never rearranges that step or the ones before it', () => {
    const before = stepsFor(BRANCHING, { role: 'developer' });
    const after = stepsFor(BRANCHING, { role: 'developer', public: 'yes' });

    expect(after.slice(0, 2).map((step) => ids(step.questions))).toEqual(
      before.slice(0, 2).map((step) => ids(step.questions)),
    );
  });
});
