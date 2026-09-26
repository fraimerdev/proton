import { describe, expect, test } from 'bun:test';
import {
  type ApplicationsConfig,
  applicationsConfigSchema,
  type FormConfig,
  formSchema,
  type PanelConfig,
  QUESTION_TYPES,
  type Question,
  questionSchema,
} from '@proton/module-applications/config';
import { FORM_TEMPLATES } from '@proton/module-applications/templates';
import type { FormOverview } from '@proton/module-applications/view';
import { ACCENT } from '../../../packages/modules/applications/src/overview.ts';
import type { GuildRole } from '../src/lib/discord.ts';
import {
  changeType,
  conditionSources,
  conditionText,
  copyName,
  countLines,
  deleteCheck,
  duplicateForm,
  duplicateQuestion,
  editorTab,
  errorLocation,
  errorLocations,
  formBadges,
  formIdProblem,
  fromLocalInput,
  fromTemplate,
  idProblem,
  intakeBadge,
  issueMap,
  issuesUnder,
  moduleSearchFor,
  moveInList,
  moveQuestionTo,
  newForm,
  newQuestion,
  outcomeSteps,
  PANEL_ACCENT,
  panelPreview,
  panelRefusal,
  queueSearchOf,
  relabelOption,
  savedIds,
  sectionDependents,
  sectionDependentsNote,
  slugify,
  slugTyping,
  stepSentence,
  takenFormIds,
  toLocalInput,
  uniqueId,
  withOptional,
  withoutConditionsOn,
  withoutForm,
} from '../src/pages/applications/shape.ts';

type Entry = FormOverview['forms'][number];

function question(input: Record<string, unknown>): Question {
  return questionSchema.parse({ id: 'q', label: 'A question', type: 'short', ...input });
}

function form(input: Record<string, unknown> = {}): FormConfig {
  return formSchema.parse({ id: 'mod', name: 'Moderator Application', ...input });
}

const BRANCHED = form({
  sections: [
    {
      id: 'about',
      title: 'About you',
      questions: [
        question({
          id: 'role',
          type: 'single',
          label: 'Which team?',
          options: [
            { value: 'dev', label: 'Developer' },
            { value: 'art', label: 'Artist' },
          ],
        }),
        question({
          id: 'portfolio',
          type: 'url',
          label: 'Portfolio',
          showIf: { questionId: 'role', values: ['dev'] },
        }),
        question({ id: 'rules', type: 'confirm', label: 'I read the rules' }),
      ],
    },
    {
      id: 'more',
      title: 'More',
      questions: [
        question({ id: 'why', type: 'paragraph', label: 'Why?' }),
        question({ id: 'extra', label: 'Extra', showIf: { questionId: 'rules', values: ['yes'] } }),
      ],
    },
  ],
});

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'mod',
    name: 'Moderator Application',
    archived: false,
    intake: { state: 'open' },
    published: { versionId: 'v3', version: 3, publishedAt: 1, publishedBy: '1' },
    draftChanged: false,
    publishIssues: [],
    requirementIssues: [],
    counts: { awaiting: 0, needsInfo: 0, drafts: 0, total: 0 },
    ...overrides,
  };
}

describe('ids', () => {
  test('slugify makes a slug the module accepts, with a fallback for nothing usable', () => {
    expect(slugify('  Moderator Application!  ', 24)).toBe('moderator-application');
    expect(slugify('Événement spécial', 24)).toBe('evenement-special');
    expect(slugify('???', 24)).toBe('form');
    expect(slugify('A very long form name that keeps going', 10)).toBe('a-very-lon');
    expect(slugify('ends with a dash -', 17)).toBe('ends-with-a-dash');
  });

  test('slugTyping keeps what a person is typing, lower case', () => {
    expect(slugTyping('My_ID two', 32)).toBe('my_id-two');
  });

  test('uniqueId adds a number until the id is free, within the length limit', () => {
    expect(uniqueId('form', new Set(), 24)).toBe('form');
    expect(uniqueId('form', new Set(['form', 'form-2']), 24)).toBe('form-3');
    expect(uniqueId('abcdef', new Set(['abcdef']), 6)).toBe('abcd-2');
  });

  test('idProblem names an empty, badly shaped or taken id', () => {
    expect(idProblem('', new Set(), 'form')).toBe('A form needs an ID.');
    expect(idProblem('-bad', new Set(), 'form')).toContain('lowercase letters');
    expect(idProblem('mod', new Set(['mod']), 'panel')).toBe(
      "Another panel already uses the ID 'mod'.",
    );
    expect(idProblem('mod', new Set(), 'form')).toBeUndefined();
  });
});

describe('forms', () => {
  test('a new form is valid and has one question to start from', () => {
    const created = newForm('staff', 'Staff');

    expect(formSchema.safeParse(created).success).toBe(true);
    expect(created.sections.flatMap((section) => section.questions)).toHaveLength(1);
    expect(created.intake.open).toBe(false);
  });

  test('every template builds a valid form under the chosen id and name', () => {
    for (const template of FORM_TEMPLATES) {
      const built = fromTemplate(template.id, 'picked-id', 'Picked name');

      expect(built.id).toBe('picked-id');
      expect(built.name).toBe('Picked name');
      expect(formSchema.safeParse(built).success).toBe(true);
    }
    expect(fromTemplate(null, 'blank', 'Blank').sections).toHaveLength(1);
  });

  test('duplicating copies everything under a new id and name, closed and unarchived', () => {
    const source = form({ archived: true, intake: { open: true } });
    const copy = duplicateForm(source, new Set(['mod', 'mod-copy']));

    expect(copy.id).toBe('mod-copy-2');
    expect(copy.name).toBe('Moderator Application copy');
    expect(copy.archived).toBe(false);
    expect(copy.intake.open).toBe(false);
    expect(copy.sections).not.toBe(source.sections);
    expect(copyName('x'.repeat(80))).toHaveLength(80);
  });

  test('deleting a form also takes it off every panel', () => {
    const config: ApplicationsConfig = applicationsConfigSchema.parse({
      forms: [form(), form({ id: 'team', name: 'Team' })],
      panels: [{ id: 'main', name: 'Main', formIds: ['mod', 'team'] }],
    });
    const next = withoutForm(config, 'mod');

    expect(next.forms.map((entry) => entry.id)).toEqual(['team']);
    expect(next.panels[0]?.formIds).toEqual(['team']);
  });

  test('a deleted form’s published id stays taken for new and duplicated forms', () => {
    const config: ApplicationsConfig = applicationsConfigSchema.parse({ forms: [form()] });
    const taken = takenFormIds(config, { retiredFormIds: ['old-mods', 'mod-copy'] });

    expect(taken).toEqual(new Set(['mod', 'old-mods', 'mod-copy']));
    expect(takenFormIds(config, undefined)).toEqual(new Set(['mod']));
    expect(duplicateForm(form(), taken).id).toBe('mod-copy-2');
    expect(uniqueId('old-mods', taken, 24)).toBe('old-mods-2');
    expect(formIdProblem('old-mods', taken, ['old-mods', 'mod-copy'])).toBe(
      "A deleted form used the ID 'old-mods', so it can’t be used again.",
    );
    expect(formIdProblem('mod', taken, ['old-mods'])).toBe(
      "Another form already uses the ID 'mod'.",
    );
    expect(formIdProblem('staff', taken, ['old-mods'])).toBeUndefined();
  });

  test('a form ever published can’t be deleted, and neither can one Proton couldn’t check', () => {
    const check = (
      overrides: Partial<Parameters<typeof deleteCheck>[0]> = {},
    ): ReturnType<typeof deleteCheck> =>
      deleteCheck({
        entry: entry({ published: null }),
        saved: true,
        fetching: false,
        failed: false,
        ...overrides,
      });

    expect(check()).toBe('allowed');
    expect(
      check({ entry: entry({ counts: { awaiting: 1, needsInfo: 0, drafts: 0, total: 1 } }) }),
    ).toBe('submissions');
    expect(check({ entry: entry() })).toBe('published');
    expect(
      check({
        entry: entry({
          published: null,
          counts: { awaiting: 0, needsInfo: 0, drafts: 2, total: 0 },
        }),
      }),
    ).toBe('published');

    expect(check({ entry: undefined, fetching: true })).toBe('waiting');
    expect(check({ fetching: true })).toBe('waiting');
    expect(check({ entry: undefined, failed: true })).toBe('unknown');
    expect(check({ entry: undefined })).toBe('unknown');
    expect(check({ failed: true })).toBe('unknown');
    expect(check({ entry: entry(), failed: true })).toBe('published');

    expect(check({ entry: undefined, saved: false, failed: true })).toBe('allowed');
  });

  test('savedIds reads ids from a stored config without trusting its shape', () => {
    expect(savedIds({ forms: [{ id: 'a' }, { name: 'x' }, 'junk'] }, 'forms')).toEqual(
      new Set(['a']),
    );
    expect(savedIds({ forms: 'nope' }, 'forms')).toEqual(new Set());
  });

  test('withOptional sets or drops a key', () => {
    expect(withOptional({ a: 1, b: 2 } as { a: number; b?: number }, 'b', undefined)).toEqual({
      a: 1,
    });
    expect(withOptional({ a: 1 } as { a: number; b?: number }, 'b', 3)).toEqual({ a: 1, b: 3 });
  });
});

describe('questions', () => {
  test('a new question of every type is valid', () => {
    for (const type of QUESTION_TYPES) {
      const created = newQuestion(type, new Set(['question']));
      expect(created.id).toBe('question-2');
      expect(questionSchema.safeParse(created).success).toBe(true);
    }
  });

  test('changing type keeps what still applies and clears the rest', () => {
    const text = question({ id: 'q', minLength: 5, maxLength: 50, placeholder: 'Hi' });

    const single = changeType(text, 'single');
    expect(single.options).toHaveLength(2);
    expect(single.minLength).toBeUndefined();
    expect(single.placeholder).toBe('');

    const number = changeType(single, 'number');
    expect(number.options).toEqual([]);

    const multiple = changeType({ ...single, minChoices: 1, maxChoices: 2 }, 'multiple');
    expect(multiple.minChoices).toBe(1);
    expect(changeType(multiple, 'single').minChoices).toBeUndefined();

    const link = changeType({ ...text, schemes: ['http'], hosts: ['github.com'] }, 'short');
    expect(link.schemes).toEqual(['https']);
    expect(link.hosts).toEqual([]);
  });

  test('an option’s value follows its label until someone edits the value', () => {
    const options = [
      { value: 'developer', label: 'Developer', description: '' },
      { value: 'custom', label: 'Artist', description: '' },
    ];

    expect(relabelOption(options, 0, 'Backend developer')[0]?.value).toBe('backend-developer');
    expect(relabelOption(options, 1, 'Illustrator')[1]?.value).toBe('custom');
  });

  test('duplicating a question keeps its condition under a fresh id and a label that fits', () => {
    const copy = duplicateQuestion(
      question({ id: 'q', label: 'x'.repeat(45), showIf: { questionId: 'role', values: ['dev'] } }),
      new Set(['q', 'q-copy']),
    );

    expect(copy.id).toBe('q-copy-2');
    expect(copy.label.length).toBeLessThanOrEqual(45);
    expect(copy.showIf).toEqual({ questionId: 'role', values: ['dev'] });
  });

  test('a condition can only name an earlier choice or confirmation question', () => {
    const ids = (questionId: string) =>
      conditionSources(BRANCHED.sections, questionId).map((q) => q.id);

    expect(ids('extra')).toEqual(['role', 'rules']);
    expect(ids('role')).toEqual([]);
    expect(ids('portfolio')).toEqual(['role']);
  });

  test('a condition reads as a sentence', () => {
    const portfolio = BRANCHED.sections[0]?.questions[1];
    const extra = BRANCHED.sections[1]?.questions[1];
    if (portfolio === undefined || extra === undefined) throw new Error('fixture changed');

    expect(conditionText(portfolio, BRANCHED.sections)).toBe(
      'Shown when “Which team?” is Developer',
    );
    expect(conditionText(extra, BRANCHED.sections)).toBe('Shown when “I read the rules” is ticked');
  });

  test('removing a question frees the questions that depended on it', () => {
    const next = withoutConditionsOn(BRANCHED.sections, new Set(['role']));

    expect(next[0]?.questions[1]?.showIf).toBeUndefined();
    expect(next[1]?.questions[1]?.showIf).toBeDefined();
  });

  test('removing a section warns about questions elsewhere that depend on it', () => {
    const dependents = sectionDependents(BRANCHED.sections, 0);

    expect(dependents.map((entry) => entry.id)).toEqual(['extra']);
    expect(sectionDependentsNote(dependents)).toBe(
      '“Extra” is shown only for answers in this section. Removing the section shows it to ' +
        'everyone.',
    );
    expect(sectionDependents(BRANCHED.sections, 1)).toEqual([]);
    expect(sectionDependentsNote([])).toBeNull();
    expect(sectionDependentsNote([...dependents, question({ id: 'more', label: 'More' })])).toBe(
      '“Extra” and “More” are shown only for answers in this section. Removing the section ' +
        'shows them to everyone.',
    );
  });

  test('moving a question to another section appends it there', () => {
    const next = moveQuestionTo(BRANCHED.sections, { section: 0, index: 2 }, 1);

    expect(next[0]?.questions.map((q) => q.id)).toEqual(['role', 'portfolio']);
    expect(next[1]?.questions.map((q) => q.id)).toEqual(['why', 'extra', 'rules']);
  });

  test('moveInList ignores a move off either end', () => {
    expect(moveInList([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveInList([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });

  test('the step sentence counts Discord steps with nothing answered', () => {
    expect(stepSentence(BRANCHED.sections)).toBe(
      'Discord shows this form in 3 steps. Answers that reveal more questions can add steps.',
    );
    expect(stepSentence([])).toBe('Discord has no questions to show yet.');
  });

  test('form problems are keyed by their path inside the form', () => {
    const broken = {
      ...BRANCHED,
      sections: [
        {
          ...BRANCHED.sections[0],
          id: 'about',
          title: '',
          description: '',
          questions: [
            question({ id: 'solo', type: 'single', options: [{ value: 'a', label: 'A' }] }),
          ],
        },
      ],
    } as FormConfig;
    const issues = issueMap(broken);

    expect(issues.get('sections.0.questions.0.options')).toBe(
      'A choice question needs at least 2 options.',
    );
    expect(issuesUnder(issues, 'sections.0.questions.0')).toHaveLength(1);
    expect(issuesUnder(issues, 'sections.0.questions.1')).toEqual([]);
  });
});

describe('what happens at each step', () => {
  const APPLICANT = '111111111111111111';
  const MODERATOR = '222222222222222222';
  const BOOSTER = '333333333333333333';
  const GONE = '444444444444444444';

  const role = (id: string, name: string, extra: Partial<GuildRole> = {}): GuildRole => ({
    id,
    name,
    position: 1,
    color: 0,
    managed: false,
    premiumSubscriber: false,
    assignable: true,
    ...extra,
  });

  const ROLES = [
    role(APPLICANT, 'Applicant'),
    role(MODERATOR, 'Moderator', { assignable: false }),
    role(BOOSTER, 'Server Booster', { managed: true, premiumSubscriber: true }),
  ];

  const configured = form({
    actions: {
      onSubmit: { addRoleIds: [APPLICANT] },
      onAccept: { addRoleIds: [MODERATOR], xp: 50 },
      onReject: { removeRoleIds: [BOOSTER, GONE] },
    },
    interview: { ticketTypeId: 'interview' },
  });

  test('lists roles, clean-up, XP and the interview ticket per step, with what will fail', () => {
    const steps = outcomeSteps(configured, {
      roles: ROLES,
      leveling: false,
      tickets: true,
      ticketTypes: [{ id: 'interview', name: 'Interview' }],
    });

    expect(steps.map((step) => step.key)).toEqual([
      'submitted',
      'accepted',
      'rejected',
      'withdrawn',
      'expired',
      'interview',
    ]);

    const lines = Object.fromEntries(steps.map((step) => [step.key, step.lines]));
    expect(lines.submitted).toEqual([
      { id: `add:${APPLICANT}`, text: 'Gives @Applicant', warning: undefined },
    ]);
    expect(lines.accepted?.map((line) => [line.text, line.warning])).toEqual([
      ['Gives @Moderator', 'This role is above Proton’s highest role, so this fails.'],
      ['Takes back @Applicant, if Proton gave it when it was sent', undefined],
      ['Gives 50 XP', 'Needs Leveling, which is off, so no XP is given.'],
    ]);
    expect(lines.rejected?.map((line) => [line.text, line.warning])).toEqual([
      ['Takes away @Server Booster', 'Discord manages the Booster role, so no bot can change it.'],
      ['Takes away @deleted role', 'That role no longer exists, so this fails.'],
      ['Takes back @Applicant, if Proton gave it when it was sent', undefined],
    ]);
    expect(lines.expired?.map((line) => line.id)).toEqual([`cleanup:${APPLICANT}`]);
    expect(lines.interview).toEqual([
      { id: 'ticket', text: 'Opens an interview ticket of type “Interview”', warning: undefined },
    ]);
  });

  test('says when a module is off or a ticket type is gone, and guesses nothing while loading', () => {
    const off = outcomeSteps(configured, {
      roles: undefined,
      leveling: undefined,
      tickets: false,
      ticketTypes: [],
    });
    const lines = Object.fromEntries(off.map((step) => [step.key, step.lines]));

    expect(lines.submitted).toEqual([{ id: `add:${APPLICANT}`, text: 'Gives @role' }]);
    expect(lines.accepted?.find((line) => line.id === 'xp')?.warning).toBeUndefined();
    expect(lines.interview?.[0]?.warning).toBe(
      'Needs Tickets, which is off, so staff can’t open one.',
    );

    const gone = outcomeSteps(configured, {
      roles: ROLES,
      leveling: true,
      tickets: true,
      ticketTypes: [],
    });
    expect(gone.at(-1)?.lines[0]).toEqual({
      id: 'ticket',
      text: 'Opens an interview ticket',
      warning: 'That ticket type no longer exists, so this fails.',
    });
  });

  test('a form that does nothing has no steps', () => {
    const quiet = form({ actions: { removeSubmitRolesOnClose: false } });

    expect(
      outcomeSteps(quiet, { roles: ROLES, leveling: true, tickets: true, ticketTypes: [] }),
    ).toEqual([]);
  });
});

describe('Discord preview helpers', () => {
  test('the panel accent matches the module’s', () => {
    expect(PANEL_ACCENT).toBe(ACCENT);
  });
});

describe('status', () => {
  test('a form never published is a draft, whatever the switch says', () => {
    expect(formBadges(undefined, form()).map((badge) => badge.label)).toEqual(['Draft']);
    expect(formBadges(entry({ published: null }), form()).map((badge) => badge.label)).toEqual([
      'Draft',
    ]);
  });

  test('a published form shows its version, unpublished changes and intake', () => {
    const labels = (from: Entry, draft: FormConfig): string[] =>
      formBadges(from, draft).map((badge) => badge.label);

    expect(labels(entry({ draftChanged: true }), form())).toEqual([
      'Published v3',
      'Unpublished changes',
      'Open',
    ]);
    expect(
      formBadges(
        entry({ intake: { state: 'closed', reason: 'not_yet_open', opensAt: 5 } }),
        form(),
      ).map((badge) => badge.label),
    ).toEqual(['Published v3', 'Scheduled']);
    expect(formBadges(entry(), form({ archived: true })).map((badge) => badge.label)).toEqual([
      'Archived',
    ]);
  });

  test('every closed reason has a text label, never colour alone', () => {
    for (const reason of ['closed', 'deadline_passed', 'full', 'archived', 'module_off'] as const) {
      expect(intakeBadge({ state: 'closed', reason })?.label).toMatch(/\w/);
    }
    expect(intakeBadge({ state: 'closed', reason: 'not_published' })).toBeNull();
  });

  test('counts read as short phrases', () => {
    const counts = { awaiting: 3, needsInfo: 1, drafts: 1, total: 9 };

    expect(countLines(entry({ counts }))).toEqual([
      '3 awaiting review',
      '1 waiting on the applicant',
      '1 draft in progress',
    ]);
  });
});

describe('panels', () => {
  const panel: PanelConfig = {
    id: 'main',
    name: 'Main',
    channelId: '100000000000000001',
    title: 'Join the team',
    body: 'Pick one.',
    formIds: ['mod'],
    style: 'buttons',
    showMine: true,
  };

  test('the preview has a button per form and the My applications button', () => {
    const [container] = panelPreview(panel, [form()]);
    if (container?.kind !== 'container') throw new Error('expected a container');

    expect(container.accentColor).toBe(PANEL_ACCENT);
    expect(JSON.stringify(container.children)).toContain('Moderator Application');
    expect(JSON.stringify(container.children)).toContain('My applications');
  });

  test('the dropdown style shows one collapsed select', () => {
    const [container] = panelPreview({ ...panel, style: 'select', showMine: false }, [form()]);
    if (container?.kind !== 'container') throw new Error('expected a container');

    expect(container.children.filter((child) => child.kind === 'row')).toHaveLength(1);
  });

  test('posting is refused with a reason until it can work', () => {
    const ready = [entry()];

    expect(panelRefusal({ panel, enabled: false, dirty: false, overview: ready })).toContain(
      'Applications is off',
    );
    const unplaced = { ...panel, channelId: undefined } as PanelConfig;

    expect(
      panelRefusal({ panel: unplaced, enabled: true, dirty: false, overview: ready }),
    ).toContain('has no channel');
    expect(panelRefusal({ panel, enabled: true, dirty: true, overview: ready })).toBe(
      'Save your changes first. Posting uses the last saved version.',
    );
    expect(
      panelRefusal({ panel, enabled: true, dirty: false, overview: [entry({ published: null })] }),
    ).toContain('is published and open');
    expect(panelRefusal({ panel, enabled: true, dirty: false, overview: ready })).toBeUndefined();
  });
});

describe('search and navigation', () => {
  test('the module search maps onto the queue search and back', () => {
    expect(queueSearchOf({ area: 'submissions', status: 'accepted', q: 'kes', page: 2 })).toEqual({
      view: 'accepted',
      q: 'kes',
      page: 2,
    });
    expect(moduleSearchFor({ view: undefined, id: 'app1' })).toEqual({
      status: undefined,
      id: 'app1',
    });
  });

  test('editorTab falls back to questions', () => {
    expect(editorTab('messages')).toBe('messages');
    expect(editorTab('nonsense')).toBe('questions');
    expect(editorTab(undefined)).toBe('questions');
  });

  test('a refused save points at the tab that owns each problem', () => {
    const config = applicationsConfigSchema.parse({
      forms: [form()],
      panels: [{ id: 'main', name: 'Main', formIds: ['mod'] }],
    });

    expect(errorLocation('forms.0.messages.accepted.content', config)).toMatchObject({
      area: 'forms',
      id: 'mod',
      status: 'messages',
    });
    expect(errorLocation('forms.0.sections.0.questions.0.label', config).status).toBe('questions');
    expect(errorLocation('panels.0.channelId', config)).toMatchObject({
      area: 'panels',
      id: 'main',
    });
    expect(errorLocation('retentionDays', config).area).toBe('settings');
    expect(
      errorLocations(['forms.0.intake.cap', 'forms.0.intake.closesAt', 'retentionDays'], config),
    ).toHaveLength(2);
  });
});

describe('local times', () => {
  test('a datetime-local value round-trips to the minute', () => {
    const at = new Date(2026, 8, 24, 13, 45).getTime();

    expect(toLocalInput(at)).toBe('2026-09-24T13:45');
    expect(fromLocalInput('2026-09-24T13:45')).toBe(at);
    expect(fromLocalInput('')).toBeUndefined();
    expect(toLocalInput(undefined)).toBe('');
  });
});
