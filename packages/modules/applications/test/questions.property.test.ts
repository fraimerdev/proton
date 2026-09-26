import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { z } from 'zod';
import {
  CONFIRM_VALUE,
  formIssues,
  QUESTION_TYPES,
  type Question,
  type QuestionType,
  questionSchema,
  questionsOf,
  type Section,
  sectionSchema,
  URL_SCHEMES,
  type UrlScheme,
} from '../src/config.ts';
import { QUESTIONS_PER_STEP } from '../src/constants.ts';
import {
  answerOf,
  checkAnswer,
  checkAnswers,
  type DraftAnswers,
  hostAllowed,
  normaliseUrl,
  parseNumber,
  pruneHidden,
  type RawAnswer,
  stepsFor,
  URL_ANSWER_MAX,
  visibleQuestions,
} from '../src/questions.ts';

type QuestionInput = z.input<typeof questionSchema>;
type SectionInput = z.input<typeof sectionSchema>;

const SOURCE_TYPES: ReadonlySet<QuestionType> = new Set(['single', 'multiple', 'confirm']);
const HOSTS = ['example.com', 'other.org'] as const;
const LETTERS = fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z');

const blueprint = fc.record({
  type: fc.constantFrom(...QUESTION_TYPES),
  required: fc.boolean(),
  newSection: fc.boolean(),
  optionCount: fc.integer({ min: 2, max: 6 }),
  dependsOn: fc.option(fc.nat(), { nil: undefined }),
  valueMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
  lengths: fc.option(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 20 })), {
    nil: undefined,
  }),
  range: fc.option(fc.tuple(fc.integer({ min: -50, max: 50 }), fc.integer({ min: 0, max: 100 })), {
    nil: undefined,
  }),
  integer: fc.boolean(),
  choices: fc.option(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 3 })), {
    nil: undefined,
  }),
  schemes: fc.subarray([...URL_SCHEMES], { minLength: 1 }),
  hosts: fc.subarray([...HOSTS]),
});

type Blueprint = typeof blueprint extends fc.Arbitrary<infer T> ? T : never;

function build(blueprints: readonly Blueprint[]): Section[] {
  const sections: (SectionInput & { questions: QuestionInput[] })[] = [];
  const earlier: { id: string; type: QuestionType; values: string[] }[] = [];

  for (const [index, bp] of blueprints.entries()) {
    if (sections.length === 0 || (bp.newSection && sections.length < 4)) {
      sections.push({ id: `s${sections.length}`, title: `Part ${sections.length}`, questions: [] });
    }

    const id = `q${index}`;
    const choice = bp.type === 'single' || bp.type === 'multiple';
    const options = choice
      ? Array.from({ length: bp.optionCount }, (_, at) => ({
          value: `o${at}`,
          label: `Option ${at}`,
        }))
      : [];

    const sources = earlier.filter((entry) => SOURCE_TYPES.has(entry.type));
    const source =
      bp.dependsOn === undefined || sources.length === 0
        ? undefined
        : sources[bp.dependsOn % sources.length];
    const picked = source?.values.filter((_, at) => bp.valueMask[at] === true) ?? [];

    const input: QuestionInput = {
      id,
      type: bp.type,
      label: `Question ${index}`,
      required: bp.required,
      options,
      schemes: bp.schemes,
      hosts: bp.hosts,
      integer: bp.integer,
      ...((bp.type === 'short' || bp.type === 'paragraph') && bp.lengths
        ? { minLength: bp.lengths[0], maxLength: bp.lengths[0] + bp.lengths[1] }
        : {}),
      ...(bp.type === 'number' && bp.range
        ? { min: bp.range[0], max: bp.range[0] + bp.range[1] }
        : {}),
      ...(bp.type === 'multiple' && bp.choices
        ? {
            minChoices: Math.min(bp.choices[0], bp.optionCount),
            maxChoices: Math.min(bp.choices[0] + bp.choices[1], bp.optionCount),
          }
        : {}),
      ...(source
        ? {
            showIf: {
              questionId: source.id,
              values: picked.length > 0 ? picked : [source.values[0] ?? CONFIRM_VALUE],
            },
          }
        : {}),
    };

    sections.at(-1)?.questions.push(input);
    earlier.push({
      id,
      type: bp.type,
      values: bp.type === 'confirm' ? [CONFIRM_VALUE] : options.map((option) => option.value),
    });
  }

  return sections.map((section) => sectionSchema.parse(section));
}

const form = fc.array(blueprint, { minLength: 1, maxLength: 18 }).map(build);

function text(min: number, max: number): fc.Arbitrary<string> {
  return fc.string({ unit: LETTERS, minLength: min, maxLength: max });
}

function validAnswer(question: Question): fc.Arbitrary<RawAnswer> {
  const values = question.options.map((option) => option.value);

  switch (question.type) {
    case 'short':
    case 'paragraph':
      return text(Math.max(1, question.minLength ?? 1), question.maxLength ?? 40);
    case 'number':
      return fc
        .integer({
          min: Math.ceil(question.min ?? -1000),
          max: Math.floor(question.max ?? 1000),
        })
        .map(String);
    case 'url': {
      const scheme = question.schemes[0] ?? 'https';
      const host = question.hosts[0] ?? 'example.com';
      return text(0, 12).map((path) => `${scheme}://${host}/${path}`);
    }
    case 'single':
      return fc.constantFrom(...values);
    case 'multiple':
      return fc.subarray(values, {
        minLength: Math.max(1, question.minChoices ?? 1),
        maxLength: question.maxChoices ?? values.length,
      });
    case 'confirm':
      return fc.constant(true);
  }
}

function anyAnswer(question: Question): fc.Arbitrary<RawAnswer> {
  return fc.oneof(
    validAnswer(question),
    fc.string({ maxLength: 50 }),
    fc.array(fc.constantFrom('o0', 'o1', 'o2', 'zz'), { maxLength: 4 }),
    fc.boolean(),
    fc.constant(''),
  );
}

function answersFor(
  sections: readonly Section[],
  pick: (question: Question) => fc.Arbitrary<RawAnswer>,
  optional: boolean,
): fc.Arbitrary<DraftAnswers> {
  const flat = questionsOf({ sections });
  return fc
    .tuple(
      ...flat.map((question) =>
        optional ? fc.option(pick(question), { nil: undefined }) : pick(question),
      ),
    )
    .map((values) => {
      const answers: DraftAnswers = {};
      for (const [index, question] of flat.entries()) {
        const value = values[index];
        if (value !== undefined) answers[question.id] = value;
      }
      return answers;
    });
}

const formWithAnswers = form.chain((sections) =>
  fc.tuple(fc.constant(sections), answersFor(sections, anyAnswer, true)),
);

const formWithValidAnswers = form.chain((sections) =>
  fc.tuple(fc.constant(sections), answersFor(sections, validAnswer, false)),
);

function oracleMet(source: Question, values: readonly string[], raw: RawAnswer | undefined) {
  const checked = checkAnswer(source, raw);
  if (!checked.ok || checked.value === null) return false;
  if (checked.value === true) return values.includes(CONFIRM_VALUE);
  const picked = Array.isArray(checked.value) ? checked.value : [checked.value];
  return picked.some((value) => typeof value === 'string' && values.includes(value));
}

function idsOf(list: readonly { id: string }[]): string[] {
  return list.map((entry) => entry.id);
}

const RUNS = { numRuns: 400 };

describe('generated forms', () => {
  test('are valid forms, so every property below is about forms an admin could publish', () => {
    fc.assert(
      fc.property(form, (sections) => formIssues({ sections }).length === 0),
      RUNS,
    );
  });
});

describe('visibility properties', () => {
  test('a question shows exactly when it has no condition, or its source shows and matches', () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const flat = questionsOf({ sections });
        const byId = new Map(flat.map((question) => [question.id, question] as const));
        const shown = new Set(idsOf(visibleQuestions(sections, answers)));

        return flat.every((question) => {
          const condition = question.showIf;
          if (condition === undefined) return shown.has(question.id);

          const source = byId.get(condition.questionId);
          if (source === undefined) return false;

          const expected =
            shown.has(source.id) &&
            oracleMet(source, condition.values, answerOf(answers, source.id));
          return shown.has(question.id) === expected;
        });
      }),
      RUNS,
    );
  });

  test('a hidden source hides every question downstream of it', () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const flat = questionsOf({ sections });
        const shown = new Set(idsOf(visibleQuestions(sections, answers)));

        return flat.every(
          (question) =>
            question.showIf === undefined ||
            !shown.has(question.id) ||
            shown.has(question.showIf.questionId),
        );
      }),
      RUNS,
    );
  });
});

describe('checkAnswers properties', () => {
  test('valid answers pass whatever is hidden, and hidden required questions never block', () => {
    fc.assert(
      fc.property(formWithValidAnswers, ([sections, answers]) => {
        const full = checkAnswers(sections, answers, { partial: false });
        const pruned = checkAnswers(sections, pruneHidden(sections, answers), { partial: false });

        return (
          full.ok &&
          pruned.ok &&
          JSON.stringify(full.answers) === JSON.stringify(pruned.answers) &&
          idsOf(visibleQuestions(sections, answers)).join() ===
            full.answers.map((answer) => answer.questionId).join()
        );
      }),
      RUNS,
    );
  });

  test('problems only ever name visible questions, and answers only visible ones', () => {
    fc.assert(
      fc.property(formWithAnswers, fc.boolean(), ([sections, answers], partial) => {
        const shown = new Set(idsOf(visibleQuestions(sections, answers)));
        const result = checkAnswers(sections, answers, { partial });
        const problems = result.ok ? [] : result.problems;

        return (
          problems.every((problem) => shown.has(problem.questionId)) &&
          result.answers.every((answer) => shown.has(answer.questionId))
        );
      }),
      RUNS,
    );
  });

  test('a checked answer with a condition always sits beside the source answer that allows it', () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const byId = new Map(questionsOf({ sections }).map((q) => [q.id, q] as const));
        const result = checkAnswers(sections, answers, { partial: true });
        const kept = new Map(result.answers.map((answer) => [answer.questionId, answer] as const));

        return result.answers.every((answer) => {
          const condition = byId.get(answer.questionId)?.showIf;
          if (condition === undefined) return true;
          const source = kept.get(condition.questionId);
          if (source === undefined) return false;
          const values = source.value === true ? [CONFIRM_VALUE] : [source.value].flat();
          return values.some(
            (value) => typeof value === 'string' && condition.values.includes(value),
          );
        });
      }),
      RUNS,
    );
  });

  test('a partial check differs from a full one only by missing required answers', () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const full = checkAnswers(sections, answers, { partial: false });
        const partial = checkAnswers(sections, answers, { partial: true });
        const fullProblems = full.ok ? [] : full.problems;
        const partialProblems = partial.ok ? [] : partial.problems;
        const extra = fullProblems.filter(
          (problem) => !partialProblems.some((other) => other.questionId === problem.questionId),
        );

        return (
          JSON.stringify(full.answers) === JSON.stringify(partial.answers) &&
          extra.every((problem) => problem.message === `“${problem.label}” needs an answer.`)
        );
      }),
      RUNS,
    );
  });

  test('pruning hidden answers is idempotent and changes nothing a check can see', () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const once = pruneHidden(sections, answers);
        const twice = pruneHidden(sections, once);

        return (
          JSON.stringify(once) === JSON.stringify(twice) &&
          JSON.stringify(checkAnswers(sections, once, { partial: false })) ===
            JSON.stringify(checkAnswers(sections, answers, { partial: false }))
        );
      }),
      RUNS,
    );
  });
});

describe('stepsFor properties', () => {
  test(`steps hold at most ${QUESTIONS_PER_STEP} questions from one section, and never a question with its source`, () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const steps = stepsFor(sections, answers);

        return steps.every((step, index) => {
          const held = new Set(idsOf(step.questions));
          return (
            step.index === index &&
            step.questions.length >= 1 &&
            step.questions.length <= QUESTIONS_PER_STEP &&
            step.questions.every((question) => question.sectionId === step.sectionId) &&
            step.questions.every(
              (question) => question.showIf === undefined || !held.has(question.showIf.questionId),
            )
          );
        });
      }),
      RUNS,
    );
  });

  test('the steps together are exactly the visible questions, in order, each once', () => {
    fc.assert(
      fc.property(formWithAnswers, ([sections, answers]) => {
        const stepped = stepsFor(sections, answers).flatMap((step) => idsOf(step.questions));
        return stepped.join() === idsOf(visibleQuestions(sections, answers)).join();
      }),
      RUNS,
    );
  });

  test('changing the answers in one step never changes that step or any before it', () => {
    const scenario = formWithAnswers.chain(([sections, answers]) => {
      const steps = stepsFor(sections, answers);
      if (steps.length === 0) return fc.constant(null);

      return fc.integer({ min: 0, max: steps.length - 1 }).chain((at) => {
        const step = steps[at];
        if (step === undefined) return fc.constant(null);

        return fc
          .tuple(
            ...step.questions.map((question) => fc.option(anyAnswer(question), { nil: undefined })),
          )
          .map((replacements) => {
            const next: DraftAnswers = { ...answers };
            for (const [index, question] of step.questions.entries()) {
              const value = replacements[index];
              if (value === undefined) delete next[question.id];
              else next[question.id] = value;
            }
            return { sections, before: steps, at, next };
          });
      });
    });

    fc.assert(
      fc.property(scenario, (input) => {
        if (input === null) return true;
        const after = stepsFor(input.sections, input.next);
        const shape = (list: typeof after) =>
          list.slice(0, input.at + 1).map((step) => idsOf(step.questions).join());

        return shape(after).join('|') === shape(input.before).join('|');
      }),
      RUNS,
    );
  });
});

describe('answer rules', () => {
  test('text is never cut: it is kept whole or refused', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 40 }),
        fc.constantFrom('short', 'paragraph'),
        (raw, minLength, span, type) => {
          const question = questionSchema.parse({
            id: 'text',
            type,
            label: 'Text',
            minLength,
            maxLength: minLength + span,
          });
          const result = checkAnswer(question, raw);
          const expected = (type === 'paragraph' ? raw.replace(/\r\n?/g, '\n') : raw).trim();

          if (expected === '') return result.ok && result.value === null;
          const fits = expected.length >= minLength && expected.length <= minLength + span;
          if (!fits) return !result.ok;
          return result.ok && result.value === expected;
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('a number is accepted exactly when it is in range and whole when it has to be', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -2000, max: 2000 }),
          fc.double({ min: -2000, max: 2000, noNaN: true, noDefaultInfinity: true }),
        ),
        fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: undefined }),
        fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
        fc.boolean(),
        (value, min, span, integer) => {
          const written = String(value);
          fc.pre(!/e/i.test(written));

          const max = min === undefined || span === undefined ? span : min + span;
          const result = parseNumber(written, { min, max, integer });
          const expected =
            (min === undefined || value >= min) &&
            (max === undefined || value <= max) &&
            (!integer || Number.isInteger(value));

          return result.ok === expected && (!result.ok || result.value === Number(written));
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('a multiple choice is accepted exactly when the count is within its bounds', () => {
    const scenario = fc.integer({ min: 2, max: 10 }).chain((count) =>
      fc.record({
        count: fc.constant(count),
        minChoices: fc.option(fc.integer({ min: 0, max: count }), { nil: undefined }),
        maxChoices: fc.option(fc.integer({ min: 1, max: count }), { nil: undefined }),
        picked: fc.subarray(
          Array.from({ length: count }, (_, at) => `o${at}`),
          { minLength: 1 },
        ),
      }),
    );

    fc.assert(
      fc.property(scenario, ({ count, minChoices, maxChoices, picked }) => {
        fc.pre(minChoices === undefined || maxChoices === undefined || minChoices <= maxChoices);

        const question = questionSchema.parse({
          id: 'pick',
          type: 'multiple',
          label: 'Pick',
          options: Array.from({ length: count }, (_, at) => ({ value: `o${at}`, label: `O${at}` })),
          ...(minChoices === undefined ? {} : { minChoices }),
          ...(maxChoices === undefined ? {} : { maxChoices }),
        });
        const result = checkAnswer(question, picked);
        const expected =
          (minChoices === undefined || picked.length >= minChoices) &&
          (maxChoices === undefined || picked.length <= maxChoices);

        return result.ok === expected;
      }),
      { numRuns: 1000 },
    );
  });

  test('a link only ever comes back with an allowed scheme and host, and normalising is stable', () => {
    const scheme = fc.constantFrom('https://', 'http://', 'ftp://', 'javascript:', 'HTTPS://', '');
    const host = fc.constantFrom(
      'example.com',
      'www.example.com',
      'other.org',
      'evil.io',
      'example.com.evil.io',
      'notexample.com',
      'localhost',
      'EXAMPLE.COM',
    );
    const path = fc.string({
      unit: fc.constantFrom('a', '/', '?', '=', '#', '%', '.'),
      maxLength: 20,
    });

    fc.assert(
      fc.property(
        scheme,
        host,
        path,
        fc.subarray([...URL_SCHEMES] as UrlScheme[], { minLength: 1 }),
        fc.subarray([...HOSTS]),
        (prefix, name, rest, schemes, hosts) => {
          const result = normaliseUrl(`${prefix}${name}${rest}`, schemes, hosts);
          if (!result.ok) return true;

          const url = new URL(result.url);
          const again = normaliseUrl(result.url, schemes, hosts);

          return (
            schemes.some((allowed) => `${allowed}:` === url.protocol) &&
            hostAllowed(url.hostname, hosts) &&
            url.username === '' &&
            url.password === '' &&
            result.url.length <= URL_ANSWER_MAX &&
            again.ok &&
            again.url === result.url
          );
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('a link naming a scheme the question does not allow is always refused', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ftp', 'javascript', 'data', 'file', 'mailto', 'http', 'https'),
        fc.subarray([...URL_SCHEMES] as UrlScheme[], { minLength: 1 }),
        (named, schemes) => {
          fc.pre(!schemes.some((allowed) => allowed === named));
          return !normaliseUrl(`${named}://example.com/x`, schemes, []).ok;
        },
      ),
    );
  });
});

describe('the generator sanity', () => {
  test('every question type turns up', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(form, (sections) => {
        for (const question of questionsOf({ sections })) seen.add(question.type);
        return true;
      }),
      { numRuns: 200 },
    );
    expect([...seen].sort()).toEqual([...QUESTION_TYPES].sort());
  });
});
