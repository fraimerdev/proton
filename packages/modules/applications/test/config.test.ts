import { describe, expect, test } from 'bun:test';
import { zodToDescriptors } from '@proton/core';
import {
  APPLICANT_MESSAGE_KEYS,
  applicationsConfigSchema,
  applicationsDefaultConfig,
  applicationsFormSchema,
  formIssues,
  formSchema,
  grantedRoles,
  liveForms,
  MESSAGE_DEFAULTS,
  panelSchema,
  questionsOf,
  reviewChannelFor,
  teamFor,
} from '../src/config.ts';

const ROLE_A = '200000000000000001';
const ROLE_B = '200000000000000002';
const ROLE_C = '200000000000000003';
const CHANNEL = '300000000000000001';
const FORM_CHANNEL = '300000000000000002';

function formInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mods',
    name: 'Moderator Application',
    sections: [
      {
        id: 'about',
        questions: [
          {
            id: 'experienced',
            type: 'single',
            label: 'Have you moderated before?',
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
          },
          {
            id: 'details',
            type: 'paragraph',
            label: 'Tell us more',
            showIf: { questionId: 'experienced', values: ['yes'] },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function issuesOf(input: unknown): string[] {
  const parsed = formSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

function withQuestions(questions: unknown[]) {
  return formInput({ sections: [{ id: 'only', questions }] });
}

const EM_DASH = '—';

describe('the stored config', () => {
  test('an empty object parses to a switched-off module with no forms', () => {
    expect(applicationsDefaultConfig.enabled).toBe(false);
    expect(applicationsDefaultConfig.forms).toEqual([]);
    expect(applicationsDefaultConfig.panels).toEqual([]);
    expect(applicationsDefaultConfig.draftExpiryDays).toBe(30);
    expect(applicationsDefaultConfig.retentionDays).toBe(30);
    expect(applicationsDefaultConfig.followUpDeadlineDays).toBe(14);
    expect(applicationsDefaultConfig.reviewReminderHours).toBe(48);
  });

  test('the flat settings schema goes through the descriptor generator the registry runs at boot', () => {
    expect(() => zodToDescriptors(applicationsFormSchema)).not.toThrow();
    expect(Object.keys(applicationsFormSchema.shape).sort()).toEqual(
      Object.keys(applicationsConfigSchema.shape)
        .filter((key) => key !== 'forms' && key !== 'panels')
        .sort(),
    );
  });

  test('a minimal form fills every default and stays closed with requirements off', () => {
    const form = formSchema.parse(formInput());

    expect(form.intake.open).toBe(false);
    expect(form.intake.cooldownDays).toBe(30);
    expect(form.intake.maxActive).toBe(1);
    expect(form.requirements).toEqual({
      roleIds: [],
      roleMode: 'any',
      blockedRoleIds: [],
      accountAgeDays: 0,
      memberAgeDays: 0,
      minLevel: 0,
      noActiveCase: false,
      noRecentCasesDays: 0,
    });
    expect(form.review.useDefaultTeam).toBe(true);
    expect(form.review.cardAnswers).toBe('summary');
    expect(form.notify.dm).toBe(true);
    expect(form.actions.onAccept.xp).toBe(0);
    expect(form.actions.removeSubmitRolesOnClose).toBe(true);
    expect(form.archived).toBe(false);
    for (const key of APPLICANT_MESSAGE_KEYS) {
      expect(form.messages[key]).toEqual(MESSAGE_DEFAULTS[key]);
    }
  });

  test('default messages carry no em dash and never ping', () => {
    for (const key of APPLICANT_MESSAGE_KEYS) {
      const message = MESSAGE_DEFAULTS[key];
      expect(JSON.stringify(message)).not.toContain(EM_DASH);
      expect(message.mentions).toEqual({ everyone: false, roles: false, users: false });
      expect(message.components).toEqual([]);
      expect(message.v2).toEqual([]);
    }
    const form = formSchema.parse(formInput());
    expect(form.messages.closed).not.toContain(EM_DASH);
    expect(form.confirmation).not.toContain(EM_DASH);
  });

  test('a form ID has to be a lowercase slug', () => {
    expect(issuesOf(formInput({ id: 'Mods' }))).not.toEqual([]);
    expect(issuesOf(formInput({ id: '-mods' }))).not.toEqual([]);
    expect(issuesOf(formInput({ id: 'a'.repeat(25) }))).not.toEqual([]);
    expect(issuesOf(formInput({ id: 'staff-2026_q4' }))).toEqual([]);
  });
});

describe('form issues', () => {
  test('section and question ids must be unique across the whole form', () => {
    const issues = issuesOf(
      formInput({
        sections: [
          { id: 'one', questions: [{ id: 'name', type: 'short', label: 'Name' }] },
          { id: 'one', questions: [{ id: 'name', type: 'short', label: 'Name again' }] },
        ],
      }),
    );

    expect(issues).toContain("sections.1.id: Another section already uses the ID 'one'.");
    expect(issues).toContain(
      "sections.1.questions.0.id: Another question already uses the ID 'name'.",
    );
  });

  test('a form holds at most 50 questions across its sections', () => {
    const section = (at: number) => ({
      id: `s${at}`,
      questions: Array.from({ length: 10 }, (_, index) => ({
        id: `q${at}-${index}`,
        type: 'short',
        label: `Question ${index}`,
      })),
    });

    expect(issuesOf(formInput({ sections: [0, 1, 2, 3, 4].map(section) }))).toEqual([]);
    expect(issuesOf(formInput({ sections: [0, 1, 2, 3, 4, 5].map(section) }))).toContain(
      'sections: A form can have at most 50 questions. This one has 60.',
    );
  });

  test('choice questions need two distinct options', () => {
    expect(
      issuesOf(
        withQuestions([
          { id: 'pick', type: 'single', label: 'Pick', options: [{ value: 'a', label: 'A' }] },
        ]),
      ),
    ).toContain('sections.0.questions.0.options: A choice question needs at least 2 options.');

    expect(
      issuesOf(
        withQuestions([
          {
            id: 'pick',
            type: 'multiple',
            label: 'Pick',
            options: [
              { value: 'a', label: 'A' },
              { value: 'a', label: 'A again' },
            ],
          },
        ]),
      ),
    ).toContain(
      "sections.0.questions.0.options.1.value: Another option already uses the value 'a'.",
    );
  });

  test('length, number and choice limits must be in order', () => {
    const issues = issuesOf(
      withQuestions([
        { id: 'text', type: 'short', label: 'Text', minLength: 20, maxLength: 10 },
        { id: 'count', type: 'number', label: 'Count', min: 10, max: 1 },
        { id: 'whole', type: 'number', label: 'Whole', integer: true, min: 1.5 },
        {
          id: 'many',
          type: 'multiple',
          label: 'Many',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
          minChoices: 2,
          maxChoices: 3,
        },
        {
          id: 'few',
          type: 'multiple',
          label: 'Few',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
          ],
          minChoices: 3,
          maxChoices: 2,
        },
      ]),
    );

    expect(issues).toContain(
      'sections.0.questions.0.minLength: The minimum length can’t be more than the maximum length.',
    );
    expect(issues).toContain(
      'sections.0.questions.1.min: The smallest number allowed can’t be bigger than the largest.',
    );
    expect(issues).toContain(
      'sections.0.questions.2.min: A whole-number question needs whole-number limits.',
    );
    expect(issues).toContain(
      'sections.0.questions.3.maxChoices: The most choices allowed can’t be more than the 2 options.',
    );
    expect(issues).toContain(
      'sections.0.questions.4.minChoices: The fewest choices allowed can’t be more than the most.',
    );
  });

  test('url hosts must be bare domains', () => {
    const issues = issuesOf(
      withQuestions([
        {
          id: 'site',
          type: 'url',
          label: 'Site',
          hosts: ['github.com', 'https://gitlab.com', 'example.com/path', 'localhost'],
        },
      ]),
    );

    expect(issues).toEqual([
      'sections.0.questions.0.hosts.1: Enter a domain like github.com, without https:// or a path.',
      'sections.0.questions.0.hosts.2: Enter a domain like github.com, without https:// or a path.',
      'sections.0.questions.0.hosts.3: Enter a domain like github.com, without https:// or a path.',
    ]);
  });

  test('hosts are stored in lowercase', () => {
    const form = formSchema.parse(
      withQuestions([{ id: 'site', type: 'url', label: 'Site', hosts: ['GitHub.com'] }]),
    );
    expect(form.sections[0]?.questions[0]?.hosts).toEqual(['github.com']);
  });
});

describe('branching is acyclic because it only looks back', () => {
  const choice = {
    id: 'pick',
    type: 'single',
    label: 'Pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  };

  test('a question may depend on an earlier choice in an earlier section', () => {
    expect(
      issuesOf(
        formInput({
          sections: [
            { id: 'one', questions: [choice] },
            {
              id: 'two',
              questions: [
                {
                  id: 'more',
                  type: 'short',
                  label: 'More',
                  showIf: { questionId: 'pick', values: ['a', 'b'] },
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test('a question cannot depend on itself', () => {
    expect(
      issuesOf(withQuestions([{ ...choice, showIf: { questionId: 'pick', values: ['a'] } }])),
    ).toContain('sections.0.questions.0.showIf.questionId: A question can’t depend on itself.');
  });

  test('a question cannot depend on a later one, which is what rules out cycles', () => {
    expect(
      issuesOf(
        withQuestions([
          {
            id: 'first',
            type: 'short',
            label: 'First',
            showIf: { questionId: 'pick', values: ['a'] },
          },
          choice,
        ]),
      ),
    ).toContain(
      'sections.0.questions.0.showIf.questionId: A question can only depend on a question that comes before it.',
    );
  });

  test('the source must exist and must be a choice or confirmation question', () => {
    expect(
      issuesOf(
        withQuestions([
          { id: 'text', type: 'short', label: 'Text' },
          {
            id: 'more',
            type: 'short',
            label: 'More',
            showIf: { questionId: 'text', values: ['a'] },
          },
          {
            id: 'ghost',
            type: 'short',
            label: 'Ghost',
            showIf: { questionId: 'missing', values: ['a'] },
          },
        ]),
      ),
    ).toEqual([
      'sections.0.questions.1.showIf.questionId: “Text” isn’t a choice or confirmation question, so it can’t control other questions.',
      "sections.0.questions.2.showIf.questionId: There’s no question with the ID 'missing' on this form.",
    ]);
  });

  test('condition values must be options of the source, and confirm only knows yes', () => {
    expect(
      issuesOf(
        withQuestions([
          choice,
          { id: 'agree', type: 'confirm', label: 'Agree' },
          {
            id: 'more',
            type: 'short',
            label: 'More',
            showIf: { questionId: 'pick', values: ['a', 'z'] },
          },
          {
            id: 'thanks',
            type: 'short',
            label: 'Thanks',
            showIf: { questionId: 'agree', values: ['yes'] },
          },
          {
            id: 'nope',
            type: 'short',
            label: 'Nope',
            showIf: { questionId: 'agree', values: ['no'] },
          },
        ]),
      ),
    ).toEqual([
      "sections.0.questions.2.showIf.values.1: “Pick” has no option 'z'.",
      "sections.0.questions.4.showIf.values.0: “Agree” has no option 'no'.",
    ]);
  });
});

describe('cross-field form rules', () => {
  test('a role cannot be both required and blocked', () => {
    expect(
      issuesOf(formInput({ requirements: { roleIds: [ROLE_A], blockedRoleIds: [ROLE_A] } })),
    ).toContain(
      'requirements.blockedRoleIds: A role can’t be both required and blocked. Take it out of one of the two lists.',
    );
  });

  test('the closing time must come after the opening time', () => {
    expect(issuesOf(formInput({ intake: { opensAt: 2000, closesAt: 1000 } }))).toContain(
      'intake.closesAt: The closing time has to be after the opening time.',
    );
    expect(issuesOf(formInput({ intake: { opensAt: 1000, closesAt: 2000 } }))).toEqual([]);
  });

  test('an outcome cannot add and remove the same role', () => {
    expect(
      issuesOf(
        formInput({ actions: { onAccept: { addRoleIds: [ROLE_A], removeRoleIds: [ROLE_A] } } }),
      ),
    ).toContain(
      'actions.onAccept.removeRoleIds: A role can’t be both added and removed. Take it out of one of the two lists.',
    );
  });

  test('formIssues on a parsed form is empty exactly when the schema accepts it', () => {
    const form = formSchema.parse(formInput());
    expect(formIssues(form)).toEqual([]);
  });
});

describe('applicant messages', () => {
  test('a DM message refuses buttons, menus and layouts', () => {
    const buttons = issuesOf(
      formInput({
        messages: {
          receipt: {
            content: 'Hi',
            components: [
              {
                kind: 'buttons',
                buttons: [{ style: 'link', label: 'Open', url: 'https://example.com' }],
              },
            ],
          },
        },
      }),
    );
    expect(buttons.some((issue) => issue.startsWith('messages.receipt.components'))).toBe(true);

    const layout = issuesOf(
      formInput({ messages: { accepted: { v2: [{ kind: 'text', content: 'Hi' }] } } }),
    );
    expect(layout.some((issue) => issue.startsWith('messages.accepted.v2'))).toBe(true);
  });

  test('an empty message is refused like everywhere else', () => {
    expect(
      issuesOf(formInput({ messages: { rejected: { content: '' } } })).some((issue) =>
        issue.startsWith('messages.rejected'),
      ),
    ).toBe(true);
  });

  test('a legacy flat embed is lifted into an embed', () => {
    const form = formSchema.parse(
      formInput({ messages: { withdrawn: { title: 'Withdrawn', description: 'Done.' } } }),
    );
    expect(form.messages.withdrawn.embeds[0]?.title).toBe('Withdrawn');
  });
});

describe('panels', () => {
  const panel = { id: 'main', name: 'Main panel', formIds: ['mods'] };

  test('defaults', () => {
    const parsed = panelSchema.parse(panel);
    expect(parsed.style).toBe('buttons');
    expect(parsed.title).toBe('Applications');
    expect(parsed.showMine).toBe(true);
  });

  test('a button panel lists at most ten forms, a dropdown up to 25', () => {
    const formIds = Array.from({ length: 11 }, (_, index) => `form-${index}`);
    expect(panelSchema.safeParse({ ...panel, formIds }).success).toBe(false);
    expect(panelSchema.safeParse({ ...panel, formIds, style: 'select' }).success).toBe(true);
    expect(
      panelSchema.safeParse({
        ...panel,
        style: 'select',
        formIds: Array.from({ length: 26 }, (_, index) => `form-${index}`),
      }).success,
    ).toBe(false);
  });

  test('a panel cannot list one form twice', () => {
    expect(panelSchema.safeParse({ ...panel, formIds: ['mods', 'mods'] }).success).toBe(false);
  });

  test('every panel form must exist, and ids are unique', () => {
    const result = applicationsConfigSchema.safeParse({
      forms: [formInput()],
      panels: [panel, { ...panel, formIds: ['mods', 'gone'] }],
    });

    expect(result.success).toBe(false);
    const messages = result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    expect(messages).toContain("panels.1.id: Another panel already uses the ID 'main'.");
    expect(messages).toContain("panels.1.formIds.1: There’s no form with the ID 'gone'.");
  });

  test('two forms cannot share an id', () => {
    const result = applicationsConfigSchema.safeParse({ forms: [formInput(), formInput()] });
    expect(result.success).toBe(false);
  });
});

describe('helpers', () => {
  const config = applicationsConfigSchema.parse({
    reviewChannelId: CHANNEL,
    reviewerRoleIds: [ROLE_A],
    deciderRoleIds: [ROLE_B],
    forms: [
      formInput(),
      formInput({
        id: 'events',
        name: 'Event Application',
        archived: true,
        review: {
          useDefaultTeam: false,
          reviewerRoleIds: [ROLE_C],
          channelId: FORM_CHANNEL,
        },
        actions: {
          onSubmit: { addRoleIds: [ROLE_A] },
          onAccept: { addRoleIds: [ROLE_B], removeRoleIds: [ROLE_C] },
        },
      }),
    ],
  });
  const [mods, events] = config.forms;
  if (mods === undefined || events === undefined) throw new Error('the forms did not parse');

  test('teamFor uses the server team unless the form has its own', () => {
    expect(teamFor(config, mods)).toEqual({
      reviewerRoleIds: [ROLE_A],
      deciderRoleIds: [ROLE_B],
      viewerRoleIds: [],
    });
    expect(teamFor(config, events)).toEqual({
      reviewerRoleIds: [ROLE_C],
      deciderRoleIds: [],
      viewerRoleIds: [],
    });
  });

  test('reviewChannelFor falls back to the server channel', () => {
    expect(reviewChannelFor(config, mods)).toBe(CHANNEL);
    expect(reviewChannelFor(config, events)).toBe(FORM_CHANNEL);
  });

  test('liveForms drops archived forms', () => {
    expect(liveForms(config).map((form) => form.id)).toEqual(['mods']);
  });

  test('questionsOf flattens in document order and remembers the section', () => {
    expect(questionsOf(mods).map((question) => [question.sectionId, question.id])).toEqual([
      ['about', 'experienced'],
      ['about', 'details'],
    ]);
  });

  test('grantedRoles lists every role an outcome would add or remove, with its path and slot', () => {
    expect(grantedRoles(config)).toEqual([
      { path: 'forms.1.actions.onSubmit.addRoleIds', roleId: ROLE_A, scope: 'events:onSubmit:add' },
      { path: 'forms.1.actions.onAccept.addRoleIds', roleId: ROLE_B, scope: 'events:onAccept:add' },
      {
        path: 'forms.1.actions.onAccept.removeRoleIds',
        roleId: ROLE_C,
        scope: 'events:onAccept:remove',
      },
    ]);
  });

  test('a grant’s slot follows the form id, not its place in the list', () => {
    const reordered = { ...config, forms: [events, mods] };
    expect(grantedRoles(reordered).map((grant) => [grant.path, grant.scope])).toEqual([
      ['forms.0.actions.onSubmit.addRoleIds', 'events:onSubmit:add'],
      ['forms.0.actions.onAccept.addRoleIds', 'events:onAccept:add'],
      ['forms.0.actions.onAccept.removeRoleIds', 'events:onAccept:remove'],
    ]);
  });
});
