import type {
  FormConfig,
  Question,
  QuestionType,
  Section,
} from '@proton/module-applications/config';
import {
  CONFIRMATION_MAX,
  FORM_DESCRIPTION_MAX,
  FORM_NAME_MAX,
  INTRO_MAX,
  QUESTIONS_PER_FORM_MAX,
  SECTION_DESCRIPTION_MAX,
  SECTION_TITLE_MAX,
  SECTIONS_MAX,
} from '@proton/module-applications/constants';
import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { LimitCounter, useRecent } from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  cx,
  IconButton,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { Icon, type IconName } from '../../components/ui/icon.tsx';
import {
  Section as PageSection,
  RowDetail,
  Rows,
  SettingRow,
} from '../../components/ui/layout.tsx';
import { ConfirmDialog } from '../../components/ui/overlay.tsx';
import { QuestionDetail } from './question-detail.tsx';
import {
  type ApplicationsForm,
  conditionText,
  dependentsOf,
  duplicateQuestion,
  type IssueMap,
  idProblem,
  issueMap,
  issuesUnder,
  moveInList,
  moveQuestionTo,
  newQuestion,
  newSection,
  QUESTION_TYPE_LABELS,
  type QuestionAt,
  questionCount,
  questionIds,
  questionTitle,
  sectionDependents,
  sectionDependentsNote,
  stepSentence,
  updateFormAt,
  withOptional,
  withoutConditionsOn,
} from './shape.ts';

const TYPE_ICONS: Readonly<Record<QuestionType, IconName>> = {
  short: 'chat-centered-text',
  paragraph: 'chat-teardrop-text',
  single: 'list',
  multiple: 'list-checks',
  number: 'hash',
  url: 'arrow-square-out',
  confirm: 'check-circle',
};

const STEPS_HELP =
  'Discord shows up to 5 questions at a time, one section per step, and starts a new step before ' +
  'a question that depends on an answer in the same step.';

const QUESTIONS_FULL = `A form can have up to ${QUESTIONS_PER_FORM_MAX} questions.`;

function dependentsNote(dependents: readonly Question[]): string {
  const names = dependents.map((question) => `“${questionTitle(question)}”`).join(', ');
  const lead = dependents.length === 1 ? 'One question is' : `${dependents.length} questions are`;
  const them = dependents.length === 1 ? 'that question' : 'them';

  return `${lead} shown only for answers to this one: ${names}. Removing it shows ${them} to everyone.`;
}

function Counter({ used, ceiling }: { used: number; ceiling: number }): ReactElement {
  return (
    <span className="field-hint applications-counter">
      {used} / {ceiling}
    </span>
  );
}

function DetailsSection({
  form,
  guildId,
  index,
  current,
}: {
  form: ApplicationsForm;
  guildId: string;
  index: number;
  current: FormConfig;
}): ReactElement {
  const path = `forms.${index}`;
  const patch = (change: (value: FormConfig) => FormConfig): void =>
    updateFormAt(form, index, change);

  const nameError =
    current.name.trim() === '' ? 'A form needs a name.' : form.errorAt(`${path}.name`);

  return (
    <PageSection label="Details">
      <Rows>
        <SettingRow title="Name" error={nameError}>
          <TextInput
            width="lg"
            aria-label="Name"
            maxLength={FORM_NAME_MAX}
            invalid={nameError !== undefined}
            value={current.name}
            onChange={(event) => patch((value) => ({ ...value, name: event.currentTarget.value }))}
          />
        </SettingRow>

        <SettingRow
          title="Description"
          description="Shown under the name on panels and the web page."
          error={form.errorAt(`${path}.description`)}
        >
          <TextInput
            width="lg"
            aria-label="Description"
            maxLength={FORM_DESCRIPTION_MAX}
            value={current.description}
            onChange={(event) =>
              patch((value) => ({ ...value, description: event.currentTarget.value }))
            }
          />
        </SettingRow>

        <SettingRow title="Icon" description="Shown on the form’s panel button.">
          <EmojiPicker
            guildId={guildId}
            label="Icon"
            value={current.emoji ?? null}
            onChange={(emoji) => patch((value) => withOptional(value, 'emoji', emoji ?? undefined))}
          />
        </SettingRow>

        <SettingRow
          stacked
          title="Introduction"
          description="Shown before someone starts, with the requirements."
          error={form.errorAt(`${path}.intro`)}
        >
          <div className="stack stack-4">
            <TextArea
              rows={3}
              aria-label="Introduction"
              maxLength={INTRO_MAX}
              value={current.intro}
              onChange={(event) =>
                patch((value) => ({ ...value, intro: event.currentTarget.value }))
              }
            />
            <Counter used={current.intro.length} ceiling={INTRO_MAX} />
          </div>
        </SettingRow>

        <SettingRow
          stacked
          title="Confirmation"
          description="Shown once they’ve sent their application."
          error={form.errorAt(`${path}.confirmation`)}
        >
          <div className="stack stack-4">
            <TextArea
              rows={2}
              aria-label="Confirmation"
              maxLength={CONFIRMATION_MAX}
              value={current.confirmation}
              onChange={(event) =>
                patch((value) => ({ ...value, confirmation: event.currentTarget.value }))
              }
            />
            <Counter used={current.confirmation.length} ceiling={CONFIRMATION_MAX} />
          </div>
        </SettingRow>
      </Rows>
    </PageSection>
  );
}

function QuestionRow({
  question,
  at,
  last,
  expanded,
  entering,
  sections,
  issues,
  serverError,
  takenIds,
  canDuplicate,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onMoveToSection,
}: {
  question: Question;
  at: QuestionAt;
  last: boolean;
  expanded: boolean;
  entering: string | undefined;
  sections: readonly Section[];
  issues: IssueMap;
  serverError: (subpath: string) => string | undefined;
  takenIds: ReadonlySet<string>;
  canDuplicate: boolean;
  onToggle: () => void;
  onChange: (next: Question) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMoveToSection: (section: number) => void;
}): ReactElement {
  const detailId = useId();
  const title = questionTitle(question);
  const condition = conditionText(question, sections);
  const prefix = `sections.${at.section}.questions.${at.index}`;
  const broken =
    question.label.trim() === '' ||
    idProblem(question.id, takenIds, 'question') !== undefined ||
    issuesUnder(issues, prefix).length > 0 ||
    serverError('') !== undefined;

  return (
    <div className={entering}>
      <div className="row-expandable">
        <Icon name={TYPE_ICONS[question.type]} size={17} className="nav-row-icon" />
        <div className="row-main">
          <div className="row-title">
            <span className="truncate">{title}</span>
            {question.required ? null : <Badge>Optional</Badge>}
            {question.showIf !== undefined ? <Badge tone="info">Conditional</Badge> : null}
            {broken ? <Badge tone="danger">Needs fixing</Badge> : null}
          </div>
          <p className="row-description">
            {QUESTION_TYPE_LABELS[question.type]} · <span className="mono">{question.id}</span>
            {condition === null ? null : <> · {condition}</>}
          </p>
        </div>

        <div className="row-control">
          <IconButton
            tone="ghost"
            size="sm"
            icon="caret-up"
            label={`Move ${title} up`}
            disabled={at.index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            tone="ghost"
            size="sm"
            icon="caret-down"
            label={`Move ${title} down`}
            disabled={last}
            onClick={() => onMove(1)}
          />
          <IconButton
            tone="ghost"
            size="sm"
            icon="clipboard-text"
            label={`Duplicate ${title}`}
            disabled={!canDuplicate}
            onClick={onDuplicate}
          />
          <IconButton
            tone="danger-quiet"
            size="sm"
            icon="trash"
            label={`Remove ${title}`}
            onClick={onRemove}
          />
        </div>

        <button
          type="button"
          className="row-disclosure"
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={expanded ? `Hide ${title}` : `Edit ${title}`}
          onClick={onToggle}
        >
          <Icon name="caret-down" size={14} weight="fill" />
        </button>
      </div>

      <RowDetail open={expanded} id={detailId}>
        {expanded ? (
          <QuestionDetail
            question={question}
            at={at}
            sections={sections}
            issues={issues}
            serverError={serverError}
            takenIds={takenIds}
            onChange={onChange}
            onMoveToSection={onMoveToSection}
          />
        ) : null}
      </RowDetail>
    </div>
  );
}

function sameAt(a: QuestionAt | null, b: QuestionAt): boolean {
  return a !== null && a.section === b.section && a.index === b.index;
}

function QuestionList({
  form,
  index,
  current,
}: {
  form: ApplicationsForm;
  index: number;
  current: FormConfig;
}): ReactElement {
  const sections = current.sections;
  const issues = useMemo(() => issueMap(current), [current]);
  const recent = useRecent();
  const [open, setOpen] = useState<QuestionAt | null>(null);
  const [removing, setRemoving] = useState<QuestionAt | null>(null);
  const [removingSection, setRemovingSection] = useState<number | null>(null);

  const total = questionCount(sections);
  const fullQuestions = total >= QUESTIONS_PER_FORM_MAX;
  const fullSections = sections.length >= SECTIONS_MAX;
  const formPath = `forms.${index}`;

  const setSections = (next: Section[]): void =>
    updateFormAt(form, index, (value) => ({ ...value, sections: next }));

  const setSection = (at: number, change: (section: Section) => Section): void =>
    setSections(sections.map((section, spot) => (spot === at ? change(section) : section)));

  const setQuestion = (at: QuestionAt, next: Question): void =>
    setSection(at.section, (section) => ({
      ...section,
      questions: section.questions.map((question, spot) => (spot === at.index ? next : question)),
    }));

  const serverErrorFor =
    (at: QuestionAt) =>
    (sub: string): string | undefined => {
      const base = `${formPath}.sections.${at.section}.questions.${at.index}`;
      if (sub !== '') return form.errorAt(`${base}.${sub}`);
      for (const key of form.errors.keys()) {
        if (key === base || key.startsWith(`${base}.`)) return form.errors.get(key);
      }
      return undefined;
    };

  const addQuestion = (at: number): void => {
    const section = sections[at];
    if (section === undefined) return;

    const spot = { section: at, index: section.questions.length };
    recent.mark(`${spot.section}:${spot.index}`);
    setSection(at, (value) => ({
      ...value,
      questions: [...value.questions, newQuestion('short', questionIds(sections))],
    }));
    setOpen(spot);
  };

  const addSection = (): void => {
    recent.mark(`section:${sections.length}`);
    setSections([
      ...sections,
      newSection(new Set(sections.map((section) => section.id)), sections.length),
    ]);
  };

  const moveSection = (at: number, delta: number): void => {
    setSections(moveInList(sections, at, at + delta));
    if (open === null) return;
    if (open.section === at) setOpen({ ...open, section: at + delta });
    else if (open.section === at + delta) setOpen({ ...open, section: at });
  };

  const dropSection = (at: number): void => {
    const removed = new Set(sections[at]?.questions.map((question) => question.id) ?? []);
    setSections(
      withoutConditionsOn(
        sections.filter((_, spot) => spot !== at),
        removed,
      ),
    );
    setOpen(null);
    setRemovingSection(null);
  };

  const moveQuestion = (at: QuestionAt, delta: number): void => {
    setSection(at.section, (section) => ({
      ...section,
      questions: moveInList(section.questions, at.index, at.index + delta),
    }));
    setOpen({ section: at.section, index: at.index + delta });
  };

  const copyQuestion = (at: QuestionAt): void => {
    const question = sections[at.section]?.questions[at.index];
    if (question === undefined) return;

    const copy = duplicateQuestion(question, questionIds(sections));
    recent.mark(`${at.section}:${at.index + 1}`);
    setSection(at.section, (section) => ({
      ...section,
      questions: [
        ...section.questions.slice(0, at.index + 1),
        copy,
        ...section.questions.slice(at.index + 1),
      ],
    }));
    setOpen({ section: at.section, index: at.index + 1 });
  };

  const dropQuestion = (at: QuestionAt): void => {
    const question = sections[at.section]?.questions[at.index];
    if (question === undefined) return;

    const kept = sections.map((section, spot) =>
      spot === at.section
        ? { ...section, questions: section.questions.filter((_, place) => place !== at.index) }
        : section,
    );
    setSections(withoutConditionsOn(kept, new Set([question.id])));
    setOpen(null);
    setRemoving(null);
  };

  const askToRemove = (at: QuestionAt): void => {
    const question = sections[at.section]?.questions[at.index];
    if (question === undefined) return;
    if (dependentsOf(sections, question.id).length > 0) setRemoving(at);
    else dropQuestion(at);
  };

  const pendingQuestion =
    removing === null ? undefined : sections[removing.section]?.questions[removing.index];
  const pendingDependents =
    pendingQuestion === undefined ? [] : dependentsOf(sections, pendingQuestion.id);
  const pendingSection = removingSection === null ? undefined : sections[removingSection];
  const sectionNote =
    removingSection === null
      ? null
      : sectionDependentsNote(sectionDependents(sections, removingSection));

  return (
    <PageSection
      label="Questions"
      help={STEPS_HELP}
      note={<LimitCounter used={total} ceiling={QUESTIONS_PER_FORM_MAX} label="questions" />}
      actions={
        <Button size="sm" icon="plus" disabled={fullSections} onClick={addSection}>
          Add section
        </Button>
      }
    >
      <p className="applications-steps" aria-live="polite">
        {stepSentence(sections)}
      </p>

      {issues.get('sections') !== undefined ? (
        <p className="row-error" role="alert">
          {issues.get('sections')}
        </p>
      ) : null}

      {sections.length === 0 ? (
        <EmptyState
          icon="list-checks"
          title="No questions yet"
          inset
          actions={
            <Button tone="primary" icon="plus" onClick={addSection}>
              Add section
            </Button>
          }
        >
          Questions live in sections. Each section is at least one step in Discord.
        </EmptyState>
      ) : null}

      <div className="stack stack-20">
        {sections.map((section, sectionAt) => {
          const takenIds = (except: number): Set<string> =>
            new Set(
              sections.flatMap((entry, spot) =>
                entry.questions
                  .filter((_, place) => !(spot === sectionAt && place === except))
                  .map((question) => question.id),
              ),
            );
          const idError = issues.get(`sections.${sectionAt}.id`);

          return (
            <div
              key={section.id}
              className={cx('applications-section', recent.enter(`section:${sectionAt}`))}
            >
              <div className="applications-section-head">
                <TextInput
                  width="md"
                  aria-label={`Section ${sectionAt + 1} title`}
                  placeholder={`Section ${sectionAt + 1}`}
                  maxLength={SECTION_TITLE_MAX}
                  value={section.title}
                  onChange={(event) =>
                    setSection(sectionAt, (value) => ({
                      ...value,
                      title: event.currentTarget.value,
                    }))
                  }
                />
                <span className="text-xs text-muted">
                  {section.questions.length}{' '}
                  {section.questions.length === 1 ? 'question' : 'questions'}
                </span>
                <span className="applications-section-controls">
                  <IconButton
                    tone="ghost"
                    size="sm"
                    icon="caret-up"
                    label={`Move section ${sectionAt + 1} up`}
                    disabled={sectionAt === 0}
                    onClick={() => moveSection(sectionAt, -1)}
                  />
                  <IconButton
                    tone="ghost"
                    size="sm"
                    icon="caret-down"
                    label={`Move section ${sectionAt + 1} down`}
                    disabled={sectionAt === sections.length - 1}
                    onClick={() => moveSection(sectionAt, 1)}
                  />
                  <IconButton
                    tone="danger-quiet"
                    size="sm"
                    icon="trash"
                    label={`Remove section ${sectionAt + 1}`}
                    onClick={() =>
                      section.questions.length === 0
                        ? dropSection(sectionAt)
                        : setRemovingSection(sectionAt)
                    }
                  />
                </span>
              </div>

              <TextInput
                width="full"
                className="applications-section-description"
                aria-label={`Section ${sectionAt + 1} description`}
                placeholder="Description, shown above this section on the web page (optional)"
                maxLength={SECTION_DESCRIPTION_MAX}
                value={section.description}
                onChange={(event) =>
                  setSection(sectionAt, (value) => ({
                    ...value,
                    description: event.currentTarget.value,
                  }))
                }
              />

              {idError !== undefined ? (
                <p className="row-error" role="alert">
                  {idError}
                </p>
              ) : null}

              {section.questions.length === 0 ? (
                <p className="applications-empty-section">No questions in this section yet.</p>
              ) : (
                <Rows>
                  {section.questions.map((question, questionAt) => {
                    const at = { section: sectionAt, index: questionAt };
                    return (
                      <QuestionRow
                        // biome-ignore lint/suspicious/noArrayIndexKey: a question's ID is editable, so its position is its identity
                        key={`${sectionAt}:${questionAt}`}
                        question={question}
                        at={at}
                        last={questionAt === section.questions.length - 1}
                        expanded={sameAt(open, at)}
                        entering={recent.enter(`${sectionAt}:${questionAt}`)}
                        sections={sections}
                        issues={issues}
                        serverError={serverErrorFor(at)}
                        takenIds={takenIds(questionAt)}
                        canDuplicate={!fullQuestions}
                        onToggle={() => setOpen(sameAt(open, at) ? null : at)}
                        onChange={(next) => setQuestion(at, next)}
                        onMove={(delta) => moveQuestion(at, delta)}
                        onDuplicate={() => copyQuestion(at)}
                        onRemove={() => askToRemove(at)}
                        onMoveToSection={(target) => {
                          setSections(moveQuestionTo(sections, at, target));
                          setOpen({
                            section: target,
                            index: sections[target]?.questions.length ?? 0,
                          });
                        }}
                      />
                    );
                  })}
                </Rows>
              )}

              <div className="applications-section-foot">
                <Button
                  size="sm"
                  icon="plus"
                  disabled={fullQuestions}
                  onClick={() => addQuestion(sectionAt)}
                >
                  Add question
                </Button>
                {fullQuestions ? (
                  <span className="text-xs text-muted">{QUESTIONS_FULL}</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingQuestion !== undefined}
        danger
        icon="trash"
        title={
          pendingQuestion === undefined
            ? 'Remove question?'
            : `Remove ${questionTitle(pendingQuestion)}?`
        }
        confirmLabel="Remove question"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing !== null && dropQuestion(removing)}
      >
        {dependentsNote(pendingDependents)}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingSection !== undefined}
        danger
        icon="trash"
        title={
          pendingSection === undefined || pendingSection.title.trim() === ''
            ? 'Remove this section?'
            : `Remove ${pendingSection.title}?`
        }
        confirmLabel="Remove section"
        onClose={() => setRemovingSection(null)}
        onConfirm={() => removingSection !== null && dropSection(removingSection)}
      >
        Its {pendingSection?.questions.length ?? 0}{' '}
        {pendingSection?.questions.length === 1 ? 'question goes' : 'questions go'} with it.
        Applications already sent keep their answers.
        {sectionNote === null ? null : ` ${sectionNote}`}
      </ConfirmDialog>
    </PageSection>
  );
}

export function QuestionsTab({
  form,
  guildId,
  index,
  current,
}: {
  form: ApplicationsForm;
  guildId: string;
  index: number;
  current: FormConfig;
}): ReactElement {
  return (
    <>
      <DetailsSection form={form} guildId={guildId} index={index} current={current} />
      <QuestionList form={form} index={index} current={current} />
    </>
  );
}
