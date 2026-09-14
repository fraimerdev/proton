import {
  ANSWER_MAX,
  type AppealPanel,
  type AppealQuestion,
  QUESTIONS_MAX,
} from '@proton/module-appeals/config';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { LimitCounter, useRecent } from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  IconButton,
  NumberStepper,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { RowDetail, Rows, Section } from '../../components/ui/layout.tsx';
import {
  type AppealsForm,
  KEY_SHAPE,
  KEY_SHAPE_MESSAGE,
  newQuestion,
  PLACEHOLDER_MAX,
  QUESTION_KEY_MAX,
  QUESTION_LABEL_MAX,
  questionKeys,
  setOptional,
  updatePanel,
} from './shape.ts';

const ANSWER_MIN = 16;

function DetailBox({
  label,
  error,
  hint,
  grow = false,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  grow?: boolean | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={grow ? 'row-detail-field appeals-field-grow' : 'row-detail-field'}>
      <span className="row-detail-label">{label}</span>
      {children}
      {error !== undefined ? (
        <span className="field-error">{error}</span>
      ) : hint !== undefined ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

function keyProblem(key: string, taken: ReadonlySet<string>): string | undefined {
  if (key.trim() === '') return 'A question needs an answer key.';
  if (!KEY_SHAPE.test(key)) return KEY_SHAPE_MESSAGE;
  if (taken.has(key)) {
    return `two questions are both keyed '${key}', so one answer would overwrite the other.`;
  }
  return undefined;
}

export function QuestionsSection({
  form,
  panel,
  index,
}: {
  form: AppealsForm;
  panel: AppealPanel;
  index: number;
}): ReactElement {
  const [open, setOpen] = useState(0);
  const recent = useRecent();

  const questions = panel.questions;
  const full = questions.length >= QUESTIONS_MAX;

  const setQuestions = (next: AppealQuestion[]): void => {
    updatePanel(form, panel.id, (current) => ({ ...current, questions: next }));
  };

  const patch = (at: number, change: (question: AppealQuestion) => AppealQuestion): void => {
    setQuestions(questions.map((question, spot) => (spot === at ? change(question) : question)));
  };

  const move = (at: number, delta: number): void => {
    const next = [...questions];
    const held = next[at];
    const other = next[at + delta];
    if (held === undefined || other === undefined) return;

    next[at] = other;
    next[at + delta] = held;
    setQuestions(next);
    setOpen(at + delta);
  };

  const add = (): void => {
    recent.mark(questions.length);
    setQuestions([...questions, newQuestion(questionKeys(panel))]);
    setOpen(questions.length);
  };

  return (
    <Section
      label="Questions"
      note={<LimitCounter used={questions.length} ceiling={QUESTIONS_MAX} label="questions" />}
      actions={
        full ? null : (
          <Button size="sm" icon="plus" onClick={add}>
            Add question
          </Button>
        )
      }
    >
      <Rows>
        {questions.map((question, at) => {
          const path = `panels.${index}.questions.${at}`;
          const taken = questionKeys(panel, at);

          const keyError = keyProblem(question.key, taken) ?? form.errorAt(`${path}.key`);
          const labelError =
            question.label.trim() === '' ? 'A question needs text.' : form.errorAt(`${path}.label`);

          const expanded = open === at;

          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the answer key is editable, so keying on it would remount the row mid-keystroke
            <div key={`question-${at}`} className={recent.enter(at)}>
              <div className="row-expandable">
                <div className="row-main">
                  <div className="row-title">
                    <span className="truncate">
                      {question.label.trim() === '' ? 'Untitled question' : question.label}
                    </span>
                    {question.required ? null : <Badge>Optional</Badge>}
                    {keyError !== undefined || labelError !== undefined ? (
                      <Badge tone="danger">Needs fixing</Badge>
                    ) : null}
                  </div>
                  <p className="row-description">
                    <span className="mono">{question.key}</span> · up to {question.maxLength}{' '}
                    characters
                  </p>
                </div>

                <div className="row-control">
                  <IconButton
                    tone="ghost"
                    size="sm"
                    icon="caret-up"
                    label="Move up"
                    disabled={at === 0}
                    onClick={() => move(at, -1)}
                  />
                  <IconButton
                    tone="ghost"
                    size="sm"
                    icon="caret-down"
                    label="Move down"
                    disabled={at === questions.length - 1}
                    onClick={() => move(at, 1)}
                  />
                  {questions.length > 1 ? (
                    <IconButton
                      tone="danger-quiet"
                      size="sm"
                      icon="trash"
                      label={`Remove ${question.label.trim() === '' ? 'question' : question.label}`}
                      onClick={() => {
                        setQuestions(questions.filter((_, spot) => spot !== at));
                        setOpen(Math.max(0, at - 1));
                      }}
                    />
                  ) : null}
                </div>

                <button
                  type="button"
                  className="row-disclosure"
                  aria-expanded={expanded}
                  aria-label={expanded ? 'Hide question' : 'Edit question'}
                  onClick={() => setOpen(expanded ? -1 : at)}
                >
                  <Icon name="caret-down" size={14} weight="fill" />
                </button>
              </div>

              <RowDetail open={expanded}>
                {expanded ? (
                  <>
                    <DetailBox label="Question" error={labelError} grow>
                      <TextInput
                        width="full"
                        aria-label="Question"
                        maxLength={QUESTION_LABEL_MAX}
                        invalid={labelError !== undefined}
                        value={question.label}
                        onChange={(event) =>
                          patch(at, (current) => ({ ...current, label: event.currentTarget.value }))
                        }
                      />
                    </DetailBox>

                    <DetailBox
                      label="Answer key"
                      error={keyError}
                      hint="Identifies this answer within the form."
                    >
                      <TextInput
                        width="sm"
                        className="mono"
                        spellCheck={false}
                        aria-label="Answer key"
                        maxLength={QUESTION_KEY_MAX}
                        invalid={keyError !== undefined}
                        value={question.key}
                        onChange={(event) =>
                          patch(at, (current) => ({ ...current, key: event.currentTarget.value }))
                        }
                      />
                    </DetailBox>

                    <DetailBox
                      label="Placeholder"
                      hint="Shown in the empty answer box."
                      error={form.errorAt(`${path}.placeholder`)}
                      grow
                    >
                      <TextInput
                        width="full"
                        aria-label="Placeholder"
                        maxLength={PLACEHOLDER_MAX}
                        value={question.placeholder ?? ''}
                        onChange={(event) =>
                          patch(at, (current) =>
                            setOptional(current, 'placeholder', event.currentTarget.value),
                          )
                        }
                      />
                    </DetailBox>

                    <DetailBox label="Answer limit" error={form.errorAt(`${path}.maxLength`)}>
                      <NumberStepper
                        label="Answer limit"
                        width={128}
                        min={ANSWER_MIN}
                        max={ANSWER_MAX}
                        value={question.maxLength}
                        invalid={form.errorAt(`${path}.maxLength`) !== undefined}
                        onChange={(next) =>
                          patch(at, (current) => ({
                            ...current,
                            maxLength: next ?? current.maxLength,
                          }))
                        }
                      />
                    </DetailBox>

                    <DetailBox label="Required">
                      <Switch
                        label="Required"
                        checked={question.required}
                        onChange={(next) =>
                          patch(at, (current) => ({ ...current, required: next }))
                        }
                      />
                    </DetailBox>
                  </>
                ) : null}
              </RowDetail>
            </div>
          );
        })}
      </Rows>

      <p className="appeals-note">
        Even when every question is optional, an empty appeal is refused with “An appeal needs at
        least one answer.”
      </p>
    </Section>
  );
}
