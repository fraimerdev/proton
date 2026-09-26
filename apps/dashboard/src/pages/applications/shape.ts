import type { ContainerChild, MessageButton, V2Component } from '@proton/core';
import {
  type ApplicationsConfig,
  CHOICE_TYPES,
  CONDITION_SOURCE_TYPES,
  CONFIRM_VALUE,
  type FlatQuestion,
  type FormConfig,
  formIssues,
  formSchema,
  type OutcomeKey,
  type PanelConfig,
  type Question,
  type QuestionType,
  questionSchema,
  questionsOf,
  type Section,
  sectionSchema,
} from '@proton/module-applications/config';
import {
  FORM_ID_MAX,
  FORM_NAME_MAX,
  OPTION_VALUE_MAX,
  PANEL_BUTTON_FORMS_MAX,
  PANEL_FORMS_MAX,
  QUESTION_ID_MAX,
  QUESTION_LABEL_MAX,
  SECTION_ID_MAX,
} from '@proton/module-applications/constants';
import { stepsFor } from '@proton/module-applications/questions';
import { templateFor } from '@proton/module-applications/templates';
import type { FormOverview, IntakeState } from '@proton/module-applications/view';
import type { ModuleForm } from '../../components/module/form.ts';
import type { ModuleSearch } from '../../components/module/route.tsx';
import type { GuildRole } from '../../lib/discord.ts';
import { failureKind, saveFailure } from '../../lib/errors.ts';

export type ApplicationsForm = ModuleForm<ApplicationsConfig>;
export type FormEntry = FormOverview['forms'][number];

export const EDITOR_TABS = [
  'questions',
  'requirements',
  'review',
  'messages',
  'actions',
  'intake',
] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

export const EDITOR_TAB_LABELS: Readonly<Record<EditorTab, string>> = {
  questions: 'Questions',
  requirements: 'Requirements',
  review: 'Review',
  messages: 'Messages',
  actions: 'Actions',
  intake: 'Intake',
};

export function editorTab(status: string | undefined): EditorTab {
  return (EDITOR_TABS as readonly string[]).includes(status ?? '')
    ? (status as EditorTab)
    : 'questions';
}

export const SLUG_SHAPE = /^[a-z0-9][a-z0-9_-]*$/;

export const ID_SHAPE =
  'Use lowercase letters, numbers, hyphens and underscores, and start with a letter or number.';

export function slugify(value: string, max: number, fallback = 'form'): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');

  return slug === '' ? fallback.slice(0, max) : slug;
}

export function slugTyping(raw: string, max: number): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, max);
}

export function uniqueId(base: string, taken: ReadonlySet<string>, max: number): string {
  const trimmed = base.slice(0, max);
  if (!taken.has(trimmed)) return trimmed;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${trimmed.slice(0, max - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }

  return trimmed;
}

export function idProblem(
  id: string,
  taken: ReadonlySet<string>,
  what: string,
): string | undefined {
  if (id.trim() === '') return `A ${what} needs an ID.`;
  if (!SLUG_SHAPE.test(id)) return ID_SHAPE;
  if (taken.has(id)) return `Another ${what} already uses the ID '${id}'.`;
  return undefined;
}

export function formIds(config: ApplicationsConfig, except?: number): Set<string> {
  return new Set(config.forms.filter((_, at) => at !== except).map((form) => form.id));
}

export function formIdProblem(
  id: string,
  taken: ReadonlySet<string>,
  retired: readonly string[],
): string | undefined {
  return retired.includes(id)
    ? `A deleted form used the ID '${id}', so it can’t be used again.`
    : idProblem(id, taken, 'form');
}

export function takenFormIds(
  config: ApplicationsConfig,
  overview: Pick<FormOverview, 'retiredFormIds'> | undefined,
): Set<string> {
  return new Set([...formIds(config), ...(overview?.retiredFormIds ?? [])]);
}

export type DeleteCheck = 'allowed' | 'waiting' | 'unknown' | 'submissions' | 'published';

export function deleteCheck(input: {
  entry: FormEntry | undefined;
  saved: boolean;
  fetching: boolean;
  failed: boolean;
}): DeleteCheck {
  const { entry, saved, fetching, failed } = input;

  if (entry !== undefined && entry.counts.total > 0) return 'submissions';
  if (entry !== undefined && (entry.published !== null || entry.counts.drafts > 0)) {
    return 'published';
  }
  if (!saved) return 'allowed';
  if (fetching) return 'waiting';
  return entry === undefined || failed ? 'unknown' : 'allowed';
}

export function panelIds(config: ApplicationsConfig, except?: number): Set<string> {
  return new Set(config.panels.filter((_, at) => at !== except).map((panel) => panel.id));
}

export function formTitle(form: Pick<FormConfig, 'id' | 'name'>): string {
  return form.name.trim() === '' ? form.id : form.name;
}

export function updateFormAt(
  form: ApplicationsForm,
  index: number,
  patch: (current: FormConfig) => FormConfig,
): void {
  form.setValue((current) => ({
    ...current,
    forms: current.forms.map((entry, at) => (at === index ? patch(entry) : entry)),
  }));
}

export function updatePanelAt(
  form: ApplicationsForm,
  index: number,
  patch: (current: PanelConfig) => PanelConfig,
): void {
  form.setValue((current) => ({
    ...current,
    panels: current.panels.map((entry, at) => (at === index ? patch(entry) : entry)),
  }));
}

export function withOptional<T extends object, K extends keyof T & string>(
  object: T,
  key: K,
  value: T[K] | undefined,
): T {
  const next: Record<string, unknown> = Object.fromEntries(Object.entries(object));
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

const STARTER_QUESTION = {
  id: 'about',
  type: 'paragraph',
  label: 'Tell us about yourself',
  maxLength: 1000,
} as const;

export function newForm(id: string, name: string): FormConfig {
  return formSchema.parse({
    id,
    name,
    sections: [{ id: 'questions', questions: [STARTER_QUESTION] }],
  });
}

export function fromTemplate(templateId: string | null, id: string, name: string): FormConfig {
  const template = templateId === null ? undefined : templateFor(templateId);
  if (template === undefined) return newForm(id, name);

  return { ...template.build(id), id, name };
}

export function copyName(name: string): string {
  const suffix = ' copy';
  return `${name.slice(0, FORM_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

export function duplicateForm(source: FormConfig, taken: ReadonlySet<string>): FormConfig {
  const id = uniqueId(slugify(`${source.id}-copy`, FORM_ID_MAX), taken, FORM_ID_MAX);
  const copy = structuredClone(source);

  return {
    ...copy,
    id,
    name: copyName(source.name),
    archived: false,
    intake: { ...copy.intake, open: false },
  };
}

export function savedIds(saved: Record<string, unknown>, key: 'forms' | 'panels'): Set<string> {
  const list = saved[key];
  if (!Array.isArray(list)) return new Set();

  return new Set(
    list.flatMap((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string'
        ? [entry.id]
        : [],
    ),
  );
}

export function panelsListing(config: ApplicationsConfig, formId: string): PanelConfig[] {
  return config.panels.filter((panel) => panel.formIds.includes(formId));
}

export function withoutForm(config: ApplicationsConfig, formId: string): ApplicationsConfig {
  return {
    ...config,
    forms: config.forms.filter((form) => form.id !== formId),
    panels: config.panels.map((panel) =>
      panel.formIds.includes(formId)
        ? { ...panel, formIds: panel.formIds.filter((id) => id !== formId) }
        : panel,
    ),
  };
}

export const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  short: 'Short answer',
  paragraph: 'Paragraph',
  single: 'Single choice',
  multiple: 'Multiple choice',
  number: 'Number',
  url: 'Link',
  confirm: 'Confirmation',
};

export const FILE_TYPE = 'file';

export const TEXT_TYPES: readonly QuestionType[] = ['short', 'paragraph'];

export function isChoice(type: QuestionType): boolean {
  return CHOICE_TYPES.includes(type);
}

export function questionIds(sections: readonly Section[]): Set<string> {
  return new Set(sections.flatMap((section) => section.questions.map((question) => question.id)));
}

export function questionCount(sections: readonly Section[]): number {
  return sections.reduce((total, section) => total + section.questions.length, 0);
}

export function questionTitle(question: Pick<Question, 'label'>): string {
  return question.label.trim() === '' ? 'Untitled question' : question.label;
}

function starterOptions(): Question['options'] {
  return [
    { value: 'option-1', label: 'Option 1', description: '' },
    { value: 'option-2', label: 'Option 2', description: '' },
  ];
}

export function newQuestion(type: QuestionType, taken: ReadonlySet<string>): Question {
  return questionSchema.parse({
    id: uniqueId('question', taken, QUESTION_ID_MAX),
    type,
    label: type === 'confirm' ? 'I agree to the rules' : 'New question',
    options: isChoice(type) ? starterOptions() : [],
  });
}

export function changeType(question: Question, type: QuestionType): Question {
  let next: Question = { ...question, type };

  if (isChoice(type)) {
    if (next.options.length < 2) next = { ...next, options: starterOptions() };
  } else {
    next = { ...next, options: [] };
  }
  if (type !== 'multiple') {
    next = withOptional(withOptional(next, 'minChoices', undefined), 'maxChoices', undefined);
  }
  if (!TEXT_TYPES.includes(type)) {
    next = withOptional(withOptional(next, 'minLength', undefined), 'maxLength', undefined);
  }
  if (type !== 'number') {
    next = {
      ...withOptional(withOptional(next, 'min', undefined), 'max', undefined),
      integer: false,
    };
  }
  if (type !== 'url') next = { ...next, schemes: ['https'], hosts: [] };
  if (type === 'confirm' || isChoice(type)) next = { ...next, placeholder: '' };

  return next;
}

export function newSection(taken: ReadonlySet<string>, index: number): Section {
  return sectionSchema.parse({
    id: uniqueId(`section-${index + 1}`, taken, SECTION_ID_MAX),
    title: `Section ${index + 1}`,
  });
}

export function optionValueFor(
  label: string,
  taken: ReadonlySet<string>,
  fallback = 'option',
): string {
  return uniqueId(slugify(label, OPTION_VALUE_MAX, fallback), taken, OPTION_VALUE_MAX);
}

export function relabelOption(
  options: Question['options'],
  at: number,
  label: string,
): Question['options'] {
  const current = options[at];
  if (current === undefined) return [...options];

  const taken = new Set(options.filter((_, spot) => spot !== at).map((option) => option.value));
  const untouched =
    current.value === '' ||
    current.value === optionValueFor(current.label, taken, `option-${at + 1}`);
  const value = untouched ? optionValueFor(label, taken, `option-${at + 1}`) : current.value;

  return options.map((option, spot) => (spot === at ? { ...option, label, value } : option));
}

export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const held = next[from];
  if (held === undefined || to < 0 || to >= next.length) return next;

  next.splice(from, 1);
  next.splice(to, 0, held);
  return next;
}

export interface QuestionAt {
  section: number;
  index: number;
}

export function questionAt(sections: readonly Section[], at: QuestionAt): Question | undefined {
  return sections[at.section]?.questions[at.index];
}

export function moveQuestionTo(
  sections: readonly Section[],
  from: QuestionAt,
  toSection: number,
): Section[] {
  const question = questionAt(sections, from);
  if (question === undefined || sections[toSection] === undefined) return [...sections];

  return sections.map((section, at) => {
    if (at === from.section && at === toSection) return section;
    if (at === from.section) {
      return { ...section, questions: section.questions.filter((_, spot) => spot !== from.index) };
    }
    if (at === toSection) return { ...section, questions: [...section.questions, question] };
    return section;
  });
}

export function conditionSources(sections: readonly Section[], questionId: string): FlatQuestion[] {
  const flat = questionsOf({ sections });
  const own = flat.findIndex((question) => question.id === questionId);
  const earlier = own === -1 ? flat : flat.slice(0, own);

  return earlier.filter((question) => CONDITION_SOURCE_TYPES.includes(question.type));
}

export function sourceChoices(source: Question): { value: string; label: string }[] {
  if (source.type === 'confirm') return [{ value: CONFIRM_VALUE, label: 'Confirmed' }];
  return source.options.map((option) => ({ value: option.value, label: option.label }));
}

export function dependentsOf(sections: readonly Section[], questionId: string): FlatQuestion[] {
  return questionsOf({ sections }).filter((question) => question.showIf?.questionId === questionId);
}

export function sectionDependents(sections: readonly Section[], at: number): FlatQuestion[] {
  const section = sections[at];
  if (section === undefined) return [];

  const inside = new Set(section.questions.map((question) => question.id));
  return questionsOf({ sections }).filter(
    (question) =>
      !inside.has(question.id) &&
      question.showIf !== undefined &&
      inside.has(question.showIf.questionId),
  );
}

export function sectionDependentsNote(dependents: readonly Question[]): string | null {
  if (dependents.length === 0) return null;

  const names = joinAnd(dependents.map((question) => `“${questionTitle(question)}”`));
  const [verb, them] = dependents.length === 1 ? ['is', 'it'] : ['are', 'them'];
  return (
    `${names} ${verb} shown only for answers in this section. Removing the section shows ` +
    `${them} to everyone.`
  );
}

export function withoutConditionsOn(
  sections: readonly Section[],
  removed: ReadonlySet<string>,
): Section[] {
  return sections.map((section) => ({
    ...section,
    questions: section.questions.map((question) =>
      question.showIf !== undefined && removed.has(question.showIf.questionId)
        ? withOptional(question, 'showIf', undefined)
        : question,
    ),
  }));
}

export function duplicateQuestion(question: Question, taken: ReadonlySet<string>): Question {
  const suffix = ' copy';
  return {
    ...structuredClone(question),
    id: uniqueId(`${question.id.slice(0, QUESTION_ID_MAX - 5)}-copy`, taken, QUESTION_ID_MAX),
    label: `${question.label.slice(0, QUESTION_LABEL_MAX - suffix.length).trimEnd()}${suffix}`,
  };
}

export function conditionText(question: Question, sections: readonly Section[]): string | null {
  const condition = question.showIf;
  if (condition === undefined) return null;

  const source = questionsOf({ sections }).find((entry) => entry.id === condition.questionId);
  if (source === undefined) return 'Shown only for an answer to a missing question';
  if (source.type === 'confirm') return `Shown when “${questionTitle(source)}” is ticked`;

  const labels = new Map(sourceChoices(source).map((choice) => [choice.value, choice.label]));
  const values = condition.values.map((value) => labels.get(value) ?? value);

  return `Shown when “${questionTitle(source)}” is ${values.length > 1 ? 'any of ' : ''}${joinOr(values)}`;
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

export function hasBranches(sections: readonly Section[]): boolean {
  return sections.some((section) => section.questions.some((question) => question.showIf));
}

export function stepCount(sections: readonly Section[]): number {
  return stepsFor(sections, {}).length;
}

export function stepSentence(sections: readonly Section[]): string {
  const steps = stepCount(sections);
  const base =
    steps === 0
      ? 'Discord has no questions to show yet.'
      : `Discord shows this form in ${steps} ${steps === 1 ? 'step' : 'steps'}.`;

  return hasBranches(sections) && steps > 0
    ? `${base} Answers that reveal more questions can add steps.`
    : base;
}

export type IssueMap = ReadonlyMap<string, string>;

export function issueMap(form: FormConfig): IssueMap {
  const map = new Map<string, string>();

  for (const issue of formIssues(form)) {
    const key = issue.path.join('.');
    if (!map.has(key)) map.set(key, issue.message);
  }

  return map;
}

export function issuesUnder(map: IssueMap, prefix: string): string[] {
  return [...map.entries()]
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
    .map(([, message]) => message);
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

export interface StatusBadge {
  tone: BadgeTone;
  label: string;
}

export function intakeBadge(state: IntakeState): StatusBadge | null {
  if (state.state === 'open') return { tone: 'success', label: 'Open' };

  switch (state.reason) {
    case 'not_yet_open':
      return { tone: 'info', label: 'Scheduled' };
    case 'archived':
      return { tone: 'neutral', label: 'Archived' };
    case 'not_published':
      return null;
    default:
      return { tone: 'neutral', label: 'Closed' };
  }
}

export function intakeDetail(state: IntakeState): string | null {
  if (state.state === 'open') return null;

  switch (state.reason) {
    case 'deadline_passed':
      return 'Deadline passed';
    case 'full':
      return 'Submission limit reached';
    case 'module_off':
      return 'Applications is off';
    default:
      return null;
  }
}

export function formBadges(entry: FormEntry | undefined, draft: FormConfig): StatusBadge[] {
  if (draft.archived) return [{ tone: 'neutral', label: 'Archived' }];

  if (entry === undefined || entry.published === null) {
    return [{ tone: 'neutral', label: 'Draft' }];
  }

  const badges: StatusBadge[] = [
    { tone: 'primary', label: `Published v${entry.published.version}` },
  ];
  if (entry.draftChanged) badges.push({ tone: 'warning', label: 'Unpublished changes' });

  const intake = intakeBadge(entry.intake);
  if (intake !== null) badges.push(intake);

  return badges;
}

export function countLines(entry: FormEntry | undefined): string[] {
  if (entry === undefined) return [];

  const lines: string[] = [];
  const { awaiting, drafts, needsInfo } = entry.counts;

  if (awaiting > 0) lines.push(`${awaiting} awaiting review`);
  if (needsInfo > 0) lines.push(`${needsInfo} waiting on the applicant`);
  if (drafts > 0) lines.push(`${drafts} ${drafts === 1 ? 'draft' : 'drafts'} in progress`);

  return lines;
}

export interface OutcomeLine {
  id: string;
  text: string;
  warning?: string | undefined;
}

export interface OutcomeStep {
  key: string;
  title: string;
  lines: OutcomeLine[];
}

export interface OutcomeContext {
  roles: readonly GuildRole[] | undefined;
  leveling: boolean | undefined;
  tickets: boolean | undefined;
  ticketTypes: readonly { id: string; name: string }[] | undefined;
}

const OUTCOME_STEPS: readonly {
  key: string;
  title: string;
  outcome?: OutcomeKey;
  closes: boolean;
}[] = [
  { key: 'submitted', title: 'When sent', outcome: 'onSubmit', closes: false },
  { key: 'accepted', title: 'When accepted', outcome: 'onAccept', closes: true },
  { key: 'rejected', title: 'When rejected', outcome: 'onReject', closes: true },
  { key: 'waitlisted', title: 'When waitlisted', outcome: 'onWaitlist', closes: false },
  { key: 'withdrawn', title: 'When withdrawn', outcome: 'onWithdraw', closes: true },
  { key: 'expired', title: 'When it expires', closes: true },
];

function roleProblem(role: GuildRole | undefined): string | undefined {
  if (role === undefined) return 'That role no longer exists, so this fails.';
  if (role.premiumSubscriber) return 'Discord manages the Booster role, so no bot can change it.';
  if (role.managed) return 'An integration manages this role, so Proton can’t change it.';
  if (!role.assignable) return 'This role is above Proton’s highest role, so this fails.';
  return undefined;
}

const ROLE_VERBS = {
  add: 'Gives',
  remove: 'Takes away',
  cleanup: 'Takes back',
} as const;

function roleLine(
  roleId: string,
  change: keyof typeof ROLE_VERBS,
  context: OutcomeContext,
): OutcomeLine {
  const id = `${change}:${roleId}`;
  const tail = change === 'cleanup' ? ', if Proton gave it when it was sent' : '';
  if (context.roles === undefined) return { id, text: `${ROLE_VERBS[change]} @role${tail}` };

  const role = context.roles.find((candidate) => candidate.id === roleId);
  return {
    id,
    text: `${ROLE_VERBS[change]} @${role?.name ?? 'deleted role'}${tail}`,
    warning: roleProblem(role),
  };
}

export function outcomeSteps(
  form: Pick<FormConfig, 'actions' | 'interview'>,
  context: OutcomeContext,
): OutcomeStep[] {
  const { actions } = form;
  const steps: OutcomeStep[] = [];

  for (const step of OUTCOME_STEPS) {
    const outcome = step.outcome === undefined ? undefined : actions[step.outcome];
    const lines: OutcomeLine[] = [
      ...(outcome?.addRoleIds ?? []).map((roleId) => roleLine(roleId, 'add', context)),
      ...(outcome?.removeRoleIds ?? []).map((roleId) => roleLine(roleId, 'remove', context)),
    ];

    if (step.closes && actions.removeSubmitRolesOnClose) {
      const adding = new Set(outcome?.addRoleIds ?? []);
      for (const roleId of actions.onSubmit.addRoleIds) {
        if (!adding.has(roleId)) lines.push(roleLine(roleId, 'cleanup', context));
      }
    }

    if (step.outcome === 'onAccept' && actions.onAccept.xp > 0) {
      lines.push({
        id: 'xp',
        text: `Gives ${actions.onAccept.xp.toLocaleString('en-GB')} XP`,
        warning:
          context.leveling === false
            ? 'Needs Leveling, which is off, so no XP is given.'
            : undefined,
      });
    }

    if (lines.length > 0) steps.push({ key: step.key, title: step.title, lines });
  }

  const typeId = form.interview.ticketTypeId;
  if (typeId !== undefined) {
    const type = context.ticketTypes?.find((candidate) => candidate.id === typeId);
    const missing = context.ticketTypes !== undefined && type === undefined;

    steps.push({
      key: 'interview',
      title: 'When staff open an interview ticket',
      lines: [
        {
          id: 'ticket',
          text:
            type === undefined
              ? 'Opens an interview ticket'
              : `Opens an interview ticket of type “${type.name}”`,
          warning:
            context.tickets === false
              ? 'Needs Tickets, which is off, so staff can’t open one.'
              : missing
                ? 'That ticket type no longer exists, so this fails.'
                : undefined,
        },
      ],
    });
  }

  return steps;
}

export const PANEL_STYLE_OPTIONS = [
  { value: 'buttons', label: 'Buttons' },
  { value: 'select', label: 'Dropdown' },
] as const;

export function panelFormLimit(style: PanelConfig['style']): number {
  return style === 'select' ? PANEL_FORMS_MAX : PANEL_BUTTON_FORMS_MAX;
}

// Mirrors ACCENT in the module's src/overview.ts; the preview drifts from the real panel otherwise.
export const PANEL_ACCENT = 0x2a8af7;

export const PANEL_SELECT_PLACEHOLDER = 'Choose a form to see what it asks';

export function panelForms(config: ApplicationsConfig, panel: PanelConfig): FormConfig[] {
  return panel.formIds
    .map((formId) => config.forms.find((form) => form.id === formId))
    .filter((form): form is FormConfig => form !== undefined);
}

export function panelPreview(panel: PanelConfig, forms: readonly FormConfig[]): V2Component[] {
  const children: ContainerChild[] = [];
  const intro = [panel.title === '' ? '' : `## ${panel.title}`, panel.body]
    .filter((part) => part !== '')
    .join('\n');

  if (intro !== '') children.push({ kind: 'text', content: intro });
  children.push({ kind: 'separator', divider: true, spacing: 'small' });

  if (panel.style === 'select') {
    children.push({
      kind: 'row',
      row: {
        kind: 'select',
        select: {
          key: 'forms',
          placeholder: PANEL_SELECT_PLACEHOLDER,
          // Empty on purpose: a collapsed select shows only its placeholder.
          options: [],
        },
      },
    });
  } else {
    const shown = forms.slice(0, PANEL_BUTTON_FORMS_MAX);

    for (let start = 0; start < shown.length; start += 5) {
      const buttons: MessageButton[] = shown.slice(start, start + 5).map((form, offset) => ({
        key: `form-${start + offset}`,
        style: 'primary',
        label: form.name.slice(0, 80),
        ...(form.emoji === undefined ? {} : { emoji: form.emoji }),
      }));
      children.push({ kind: 'row', row: { kind: 'buttons', buttons } });
    }
  }

  if (panel.showMine) {
    children.push({
      kind: 'row',
      row: {
        kind: 'buttons',
        buttons: [{ key: 'mine', style: 'secondary', label: 'My applications' }],
      },
    });
  }

  return [{ kind: 'container', accentColor: panel.colour ?? PANEL_ACCENT, children }];
}

export const PANEL_DIRTY = 'Save your changes first. Posting uses the last saved version.';

export const PANEL_MODULE_OFF =
  'Applications is off, so no one could use this panel. Turn Applications on first.';

export function panelRefusal(input: {
  panel: PanelConfig;
  enabled: boolean;
  dirty: boolean;
  overview: readonly FormEntry[] | undefined;
}): string | undefined {
  const { panel, enabled, dirty, overview } = input;

  if (!enabled) return PANEL_MODULE_OFF;
  if (panel.channelId === undefined) {
    return `${panel.name} has no channel yet. Choose one and save, then post it.`;
  }
  if (dirty) return PANEL_DIRTY;
  if (overview === undefined) return undefined;

  const ready = panel.formIds.some((formId) => {
    const entry = overview.find((candidate) => candidate.id === formId);
    if (entry === undefined || entry.published === null || entry.archived) return false;
    return (
      entry.intake.state === 'open' ||
      (entry.intake.state === 'closed' && entry.intake.reason === 'not_yet_open')
    );
  });

  return ready
    ? undefined
    : `None of the forms on ${panel.name} is published and open. Publish one and turn on ` +
        'Accepting applications, then post the panel.';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function toLocalInput(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';

  const date = new Date(ms);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function fromLocalInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function asSentence(message: string): string {
  const trimmed = message.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function failureText(error: Error, attempt: string): string {
  return failureKind(error) === 'unknown' && error.message.trim() !== ''
    ? `${attempt}. ${asSentence(error.message)}`
    : saveFailure(error, attempt);
}

export interface QueueSearch {
  view?: string | undefined;
  q?: string | undefined;
  page?: number | undefined;
  id?: string | undefined;
}

export function queueSearchOf(search: ModuleSearch): QueueSearch {
  return {
    ...(search.status === undefined ? {} : { view: search.status }),
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.page === undefined ? {} : { page: search.page }),
    ...(search.id === undefined ? {} : { id: search.id }),
  };
}

export function moduleSearchFor(patch: Partial<QueueSearch>): ModuleSearch {
  const next: ModuleSearch = {};
  if ('view' in patch) next.status = patch.view;
  if ('q' in patch) next.q = patch.q;
  if ('page' in patch) next.page = patch.page;
  if ('id' in patch) next.id = patch.id;
  return next;
}

const TAB_OF_KEY: Readonly<Record<string, EditorTab>> = {
  id: 'questions',
  name: 'questions',
  description: 'questions',
  emoji: 'questions',
  intro: 'questions',
  confirmation: 'questions',
  sections: 'questions',
  requirements: 'requirements',
  review: 'review',
  messages: 'messages',
  notify: 'messages',
  actions: 'actions',
  interview: 'actions',
  intake: 'intake',
  archived: 'intake',
};

export interface ErrorLocation {
  key: string;
  label: string;
  area: 'forms' | 'panels' | 'settings';
  id?: string;
  status?: EditorTab;
}

export function errorLocation(path: string, config: ApplicationsConfig): ErrorLocation {
  const [head, at, field] = path.split('.');
  const index = Number(at);

  if (head === 'forms' && Number.isInteger(index)) {
    const entry = config.forms[index];
    if (entry !== undefined) {
      const status = TAB_OF_KEY[field ?? ''] ?? 'questions';
      return {
        key: `form:${entry.id}:${status}`,
        label: `${formTitle(entry)} · ${EDITOR_TAB_LABELS[status]}`,
        area: 'forms',
        id: entry.id,
        status,
      };
    }
    return { key: 'forms', label: 'Forms', area: 'forms' };
  }

  if (head === 'panels' && Number.isInteger(index)) {
    const entry = config.panels[index];
    return entry === undefined
      ? { key: 'panels', label: 'Panels', area: 'panels' }
      : { key: `panel:${entry.id}`, label: `${entry.name} panel`, area: 'panels', id: entry.id };
  }

  if (head === 'forms') return { key: 'forms', label: 'Forms', area: 'forms' };
  if (head === 'panels') return { key: 'panels', label: 'Panels', area: 'panels' };

  return { key: 'settings', label: 'Settings', area: 'settings' };
}

export function errorLocations(
  paths: Iterable<string>,
  config: ApplicationsConfig,
): ErrorLocation[] {
  const seen = new Map<string, ErrorLocation>();

  for (const path of paths) {
    const location = errorLocation(path, config);
    if (!seen.has(location.key)) seen.set(location.key, location);
  }

  return [...seen.values()];
}

export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
