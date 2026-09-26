import { describe, expect, test } from 'bun:test';
import {
  applicationsConfigSchema,
  formIssues,
  formSchema,
  questionsOf,
  requirementsSchema,
} from '../src/config.ts';
import { checkAnswers, stepsFor, visibleQuestions } from '../src/questions.ts';
import { FORM_TEMPLATE_IDS, FORM_TEMPLATES, templateFor } from '../src/templates.ts';
import { publishIssues } from '../src/version.ts';

describe('FORM_TEMPLATES', () => {
  test('there are four, named for what they recruit', () => {
    expect(FORM_TEMPLATES.map(({ id, name }) => [id, name])).toEqual([
      ['moderator', 'Moderator Application'],
      ['team', 'Team Application'],
      ['partnership', 'Partnership Request'],
      ['event', 'Event Application'],
    ]);
    expect(FORM_TEMPLATES.map(({ id }) => id)).toEqual([...FORM_TEMPLATE_IDS]);
  });

  for (const template of FORM_TEMPLATES) {
    describe(template.name, () => {
      const form = template.build(`${template.id}-2026`);
      const questions = questionsOf(form);

      test('builds a valid, publishable form under the id it is given', () => {
        expect(form.id).toBe(`${template.id}-2026`);
        expect(formSchema.parse(JSON.parse(JSON.stringify(form)))).toEqual(form);
        expect(formIssues(form)).toEqual([]);
        expect(publishIssues(form)).toEqual([]);
      });

      test('has sections and 6 to 12 questions with at least one branch', () => {
        expect(form.sections.length).toBeGreaterThanOrEqual(2);
        expect(questions.length).toBeGreaterThanOrEqual(6);
        expect(questions.length).toBeLessThanOrEqual(12);
        expect(questions.some((question) => question.showIf !== undefined)).toBe(true);
        expect(form.sections.every((section) => section.title.length > 0)).toBe(true);
      });

      test('starts closed, with every requirement off and no outcome actions', () => {
        expect(form.intake.open).toBe(false);
        expect(form.requirements).toEqual(requirementsSchema.parse({}));
        expect(form.archived).toBe(false);
        expect(form.actions.onAccept).toEqual({ addRoleIds: [], removeRoleIds: [], xp: 0 });
        expect(form.review.useDefaultTeam).toBe(true);
      });

      test('reads as plain copy with no em dashes', () => {
        const text = JSON.stringify({ form, summary: template.summary });
        expect(text).not.toContain('—');
        expect(form.description.length).toBeGreaterThan(0);
        expect(form.intro.length).toBeGreaterThan(0);
        expect(form.confirmation.length).toBeGreaterThan(0);
        expect(template.summary.endsWith('.')).toBe(true);
      });

      test('fits Discord’s modals: every step holds five questions at most', () => {
        const everything = Object.fromEntries(
          questions.flatMap((question) =>
            question.options.length > 0
              ? [[question.id, question.options.map((option) => option.value)]]
              : [],
          ),
        );
        for (const step of stepsFor(form.sections, everything)) {
          expect(step.questions.length).toBeLessThanOrEqual(5);
        }
      });
    });
  }

  test('every build is a fresh copy', () => {
    const team = templateFor('team');
    if (team === undefined) throw new Error('no team template');

    const first = team.build('team');
    first.sections[0]?.questions.pop();
    first.name = 'Changed';

    const second = team.build('team');
    expect(second.name).toBe('Team Application');
    expect(questionsOf(second).length).toBe(9);
  });

  test('an id that is not a slug is refused', () => {
    expect(() => FORM_TEMPLATES[0]?.build('Not A Slug')).toThrow();
  });

  test('the four templates can live side by side in one server', () => {
    const config = applicationsConfigSchema.safeParse({
      forms: FORM_TEMPLATES.map((template) => template.build(template.id)),
    });
    expect(config.success).toBe(true);
  });

  test('templateFor finds by id', () => {
    expect(templateFor('event')?.name).toBe('Event Application');
    expect(templateFor('scratch')).toBeUndefined();
  });
});

describe('the branches do what they say', () => {
  test('choosing Developer on the team form asks for a portfolio link', () => {
    const form = templateFor('team')?.build('team');
    if (form === undefined) throw new Error('no team template');

    const shown = (role: string) =>
      visibleQuestions(form.sections, { role }).map((question) => question.id);

    expect(shown('developer')).toContain('portfolio');
    expect(shown('developer')).toContain('languages');
    expect(shown('designer')).not.toContain('portfolio');
    expect(shown('designer')).toContain('design-portfolio');
  });

  test('a moderator applicant with no experience is not asked about it', () => {
    const form = templateFor('moderator')?.build('mods');
    if (form === undefined) throw new Error('no moderator template');

    const answers = {
      timezone: 'UTC+1',
      hours: '5-10',
      why: 'I have been here for two years and want to help keep it friendly for everyone.',
      experienced: 'no',
      'experience-details': 'left over from an earlier answer',
      argument: 'Move it to DMs, remind both of the rules, and follow up with each of them.',
      'friend-report': 'Hand it to another moderator so the decision is fair to everyone.',
      rules: true,
    };

    const result = checkAnswers(form.sections, answers, { partial: false });
    expect(result.ok).toBe(true);
    expect(result.answers.some((answer) => answer.questionId === 'experience-details')).toBe(false);
  });

  test('a partnership for a server asks for an invite on Discord’s own domains', () => {
    const form = templateFor('partnership')?.build('partners');
    if (form === undefined) throw new Error('no partnership template');

    const invite = questionsOf(form).find((question) => question.id === 'invite');
    expect(invite?.hosts).toEqual(['discord.gg', 'discord.com']);
    const shown = (kind: string) =>
      visibleQuestions(form.sections, { kind }).map((question) => question.id);

    expect(shown('server')).toContain('invite');
    expect(shown('creator')).not.toContain('invite');
    expect(shown('creator')).toContain('link');
  });

  test('an event team signs up with a team name', () => {
    const form = templateFor('event')?.build('event');
    if (form === undefined) throw new Error('no event template');

    const ids = visibleQuestions(form.sections, { as: 'team' }).map((question) => question.id);
    expect(ids).toContain('team-name');
    expect(ids).not.toContain('helping');
  });
});
