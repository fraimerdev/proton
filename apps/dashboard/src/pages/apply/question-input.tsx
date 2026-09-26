import type { Question } from '@proton/module-applications/config';
import { TEXT_ANSWER_MAX } from '@proton/module-applications/constants';
import type { RawAnswer } from '@proton/module-applications/questions';
import type { ReactElement, ReactNode } from 'react';
import {
  Button,
  cx,
  SegmentedControl,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';

export type AnswerableQuestion = Pick<
  Question,
  | 'id'
  | 'type'
  | 'label'
  | 'help'
  | 'placeholder'
  | 'required'
  | 'minLength'
  | 'maxLength'
  | 'min'
  | 'max'
  | 'integer'
  | 'schemes'
  | 'hosts'
  | 'options'
  | 'minChoices'
  | 'maxChoices'
>;

const SEGMENTED_OPTIONS_MAX = 4;
const SEGMENTED_LABEL_MAX = 20;

export function questionAnchor(questionId: string): string {
  return `apply-q-${questionId}`;
}

export function segmentedFits(question: Pick<Question, 'type' | 'options'>): boolean {
  return (
    question.type === 'single' &&
    question.options.length >= 2 &&
    question.options.length <= SEGMENTED_OPTIONS_MAX &&
    question.options.every(
      (option) => option.label.length <= SEGMENTED_LABEL_MAX && option.description === '',
    )
  );
}

export function inputModeOf(
  question: Pick<Question, 'type' | 'integer' | 'min'>,
): 'text' | 'numeric' | 'decimal' | 'url' {
  if (question.type === 'url') return 'url';
  if (question.type !== 'number') return 'text';

  // Phone keypads for these modes have no minus key, so a range that allows one needs letters.
  if (question.min === undefined || question.min < 0) return 'text';
  return question.integer ? 'numeric' : 'decimal';
}

export function textLimit(question: Pick<Question, 'maxLength'>): number {
  return Math.min(question.maxLength ?? TEXT_ANSWER_MAX, TEXT_ANSWER_MAX);
}

export function numberHint(question: Pick<Question, 'min' | 'max' | 'integer'>): string | null {
  const noun = question.integer ? 'A whole number' : 'A number';
  const { min, max } = question;

  if (min !== undefined && max !== undefined) return `${noun} from ${min} to ${max}.`;
  if (min !== undefined) return `${noun} of ${min} or more.`;
  if (max !== undefined) return `${noun} of ${max} or less.`;
  return question.integer ? 'A whole number.' : null;
}

function listOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

export function urlHint(question: Pick<Question, 'schemes' | 'hosts'>): string | null {
  if (question.hosts.length > 0) return `A link to ${listOr(question.hosts)}.`;
  if (!question.schemes.includes('https')) return 'A link that starts with http://.';
  return null;
}

export function choiceHint(question: Pick<Question, 'minChoices' | 'maxChoices'>): string {
  const { minChoices: min, maxChoices: max } = question;

  if (min !== undefined && min > 0 && max !== undefined) {
    return min === max ? `Choose exactly ${min}.` : `Choose ${min} to ${max}.`;
  }
  if (min !== undefined && min > 0) return `Choose at least ${min}.`;
  if (max !== undefined) return `Choose up to ${max}.`;
  return 'Choose any that apply.';
}

export function lengthHint(
  question: Pick<Question, 'type' | 'minLength' | 'maxLength'>,
): string | null {
  const min =
    question.minLength !== undefined && question.minLength > 0 ? question.minLength : null;

  if (question.type === 'paragraph') return min === null ? null : `At least ${min} characters.`;
  if (min !== null && question.maxLength !== undefined) {
    return `${min} to ${textLimit(question)} characters.`;
  }
  if (min !== null) return `At least ${min} characters.`;
  if (question.maxLength !== undefined) return `Up to ${textLimit(question)} characters.`;
  return null;
}

function Required({
  required,
  spoken = false,
}: {
  required: boolean;
  spoken?: boolean;
}): ReactNode {
  if (!required) return null;

  return (
    <>
      <span className="apply-required" aria-hidden="true">
        *
      </span>
      {spoken ? <span className="visually-hidden"> (required)</span> : null}
    </>
  );
}

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined === '' ? undefined : joined;
}

export interface QuestionInputProps {
  question: AnswerableQuestion;
  value: RawAnswer | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
  onChange: (value: RawAnswer | undefined) => void;
  onBlur: () => void;
}

export function QuestionInput(props: QuestionInputProps): ReactElement {
  switch (props.question.type) {
    case 'paragraph':
      return <ParagraphInput {...props} />;
    case 'single':
      return segmentedFits(props.question) ? (
        <SegmentedInput {...props} />
      ) : (
        <RadioInput {...props} />
      );
    case 'multiple':
      return <CheckboxListInput {...props} />;
    case 'confirm':
      return <ConfirmInput {...props} />;
    default:
      return <LineInput {...props} />;
  }
}

function ids(question: AnswerableQuestion, error: string | undefined, hinted: boolean) {
  const base = questionAnchor(question.id);

  return {
    base,
    control: `${base}-control`,
    label: `${base}-label`,
    help: question.help === '' ? undefined : `${base}-help`,
    hint: hinted ? `${base}-hint` : undefined,
    error: error === undefined ? undefined : `${base}-error`,
  };
}

function Help({ id, text }: { id: string | undefined; text: string }): ReactNode {
  if (id === undefined) return null;
  return (
    <p className="apply-question-help" id={id}>
      {text}
    </p>
  );
}

function ErrorLine({
  id,
  error,
}: {
  id: string | undefined;
  error: string | undefined;
}): ReactNode {
  if (id === undefined || error === undefined) return null;
  return (
    <p className="field-error apply-question-error" id={id}>
      {error}
    </p>
  );
}

function CheckMark(): ReactElement {
  return (
    <span className="apply-check-mark" aria-hidden="true">
      <Icon name="check" size={12} weight="fill" />
    </span>
  );
}

function LineInput({ question, value, error, disabled, onChange, onBlur }: QuestionInputProps) {
  const hint =
    question.type === 'number'
      ? numberHint(question)
      : question.type === 'url'
        ? urlHint(question)
        : lengthHint(question);
  const id = ids(question, error, hint !== null);
  // Not URL_ANSWER_MAX for links: the browser would silently cut a long link into a different one.
  const limit = question.type === 'short' ? textLimit(question) : TEXT_ANSWER_MAX;

  return (
    <div className="apply-question" id={id.base}>
      <label className="apply-question-label" htmlFor={id.control}>
        {question.label}
        <Required required={question.required} />
      </label>
      <Help id={id.help} text={question.help} />
      <TextInput
        id={id.control}
        type={question.type === 'url' ? 'url' : 'text'}
        inputMode={inputModeOf(question)}
        autoComplete={question.type === 'url' ? 'url' : 'off'}
        maxLength={limit}
        placeholder={question.placeholder === '' ? undefined : question.placeholder}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        invalid={error !== undefined}
        aria-required={question.required ? true : undefined}
        aria-describedby={describedBy(id.help, id.hint, id.error)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
      />
      {hint !== null ? (
        <p className="field-hint apply-question-hint" id={id.hint}>
          {hint}
        </p>
      ) : null}
      <ErrorLine id={id.error} error={error} />
    </div>
  );
}

function ParagraphInput({
  question,
  value,
  error,
  disabled,
  onChange,
  onBlur,
}: QuestionInputProps) {
  const text = typeof value === 'string' ? value : '';
  const limit = textLimit(question);
  const hint = lengthHint(question);
  const id = ids(question, error, true);

  return (
    <div className="apply-question" id={id.base}>
      <label className="apply-question-label" htmlFor={id.control}>
        {question.label}
        <Required required={question.required} />
      </label>
      <Help id={id.help} text={question.help} />
      <TextArea
        id={id.control}
        rows={5}
        maxLength={limit}
        placeholder={question.placeholder === '' ? undefined : question.placeholder}
        value={text}
        disabled={disabled}
        invalid={error !== undefined}
        aria-required={question.required ? true : undefined}
        aria-describedby={describedBy(id.help, id.hint, id.error)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
      />
      <p className="field-hint apply-question-hint apply-question-count" id={id.hint}>
        <span>{hint}</span>
        <span className="apply-counter">
          {text.length} / {limit}
        </span>
      </p>
      <ErrorLine id={id.error} error={error} />
    </div>
  );
}

function ClearAnswer({
  question,
  shown,
  disabled,
  onClear,
}: {
  question: AnswerableQuestion;
  shown: boolean;
  disabled: boolean | undefined;
  onClear: () => void;
}): ReactNode {
  if (question.required || !shown) return null;

  return (
    <Button tone="ghost" size="sm" className="apply-clear" disabled={disabled} onClick={onClear}>
      Clear answer
    </Button>
  );
}

function SegmentedInput({ question, value, error, disabled, onChange }: QuestionInputProps) {
  const id = ids(question, error, false);
  const chosen = typeof value === 'string' ? value : '';

  return (
    <div className="apply-question" id={id.base}>
      <p className="apply-question-label" id={id.label}>
        {question.label}
        <Required required={question.required} />
      </p>
      <Help id={id.help} text={question.help} />
      <SegmentedControl
        block
        label={question.required ? `${question.label} (required)` : question.label}
        options={question.options.map((option) => ({ value: option.value, label: option.label }))}
        value={chosen}
        disabled={disabled}
        onChange={(next) => onChange(next)}
      />
      <ClearAnswer
        question={question}
        shown={chosen !== ''}
        disabled={disabled}
        onClear={() => onChange(undefined)}
      />
      <ErrorLine id={id.error} error={error} />
    </div>
  );
}

function RadioInput({ question, value, error, disabled, onChange }: QuestionInputProps) {
  const id = ids(question, error, false);
  const chosen = typeof value === 'string' ? value : '';

  return (
    <div className="apply-question" id={id.base}>
      <p className="apply-question-label" id={id.label}>
        {question.label}
        <Required required={question.required} />
      </p>
      <Help id={id.help} text={question.help} />
      <div
        className="apply-choices"
        role="radiogroup"
        aria-labelledby={id.label}
        aria-describedby={describedBy(id.help, id.error)}
        aria-required={question.required ? true : undefined}
        aria-invalid={error !== undefined ? true : undefined}
      >
        {question.options.map((option) => {
          const note = option.description === '' ? undefined : `${id.base}-${option.value}-note`;

          return (
            <label
              key={option.value}
              className={cx('apply-choice', chosen === option.value && 'chosen')}
            >
              <input
                type="radio"
                className="apply-radio"
                name={id.base}
                value={option.value}
                checked={chosen === option.value}
                disabled={disabled}
                aria-describedby={note}
                onChange={() => onChange(option.value)}
              />
              <span className="apply-choice-text">
                <span className="apply-choice-label">{option.label}</span>
                {note !== undefined ? (
                  <span className="apply-choice-note" id={note}>
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <ClearAnswer
        question={question}
        shown={chosen !== ''}
        disabled={disabled}
        onClear={() => onChange(undefined)}
      />
      <ErrorLine id={id.error} error={error} />
    </div>
  );
}

function pickedOf(value: RawAnswer | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function CheckboxListInput({ question, value, error, disabled, onChange }: QuestionInputProps) {
  const id = ids(question, error, true);
  const picked = pickedOf(value);

  const toggle = (choice: string, on: boolean): void => {
    const next = question.options
      .map((option) => option.value)
      .filter((candidate) => (candidate === choice ? on : picked.includes(candidate)));
    onChange(next.length === 0 ? undefined : next);
  };

  return (
    <div className="apply-question" id={id.base}>
      <p className="apply-question-label" id={id.label}>
        {question.label}
        <Required required={question.required} spoken />
      </p>
      <Help id={id.help} text={question.help} />
      <p className="field-hint apply-question-hint" id={id.hint}>
        {choiceHint(question)}
      </p>
      <fieldset
        className="apply-choices"
        aria-labelledby={id.label}
        aria-describedby={describedBy(id.help, id.hint, id.error)}
      >
        {question.options.map((option) => {
          const on = picked.includes(option.value);
          const note = option.description === '' ? undefined : `${id.base}-${option.value}-note`;

          return (
            <label key={option.value} className={cx('apply-choice', on && 'chosen')}>
              <input
                type="checkbox"
                className="apply-check"
                value={option.value}
                checked={on}
                disabled={disabled}
                aria-invalid={error !== undefined ? true : undefined}
                aria-describedby={note}
                onChange={(event) => toggle(option.value, event.currentTarget.checked)}
              />
              <CheckMark />
              <span className="apply-choice-text">
                <span className="apply-choice-label">{option.label}</span>
                {note !== undefined ? (
                  <span className="apply-choice-note" id={note}>
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <ErrorLine id={id.error} error={error} />
    </div>
  );
}

function ConfirmInput({ question, value, error, disabled, onChange }: QuestionInputProps) {
  const id = ids(question, error, false);
  const on = value === true;

  return (
    <div className="apply-question" id={id.base}>
      <label className={cx('apply-choice', 'apply-confirm', on && 'chosen')}>
        <input
          type="checkbox"
          className="apply-check"
          id={id.control}
          checked={on}
          disabled={disabled}
          aria-required={question.required ? true : undefined}
          aria-invalid={error !== undefined ? true : undefined}
          aria-describedby={describedBy(id.help, id.error)}
          onChange={(event) => onChange(event.currentTarget.checked ? true : undefined)}
        />
        <CheckMark />
        <span className="apply-choice-text">
          <span className="apply-choice-label">
            {question.label}
            <Required required={question.required} />
          </span>
        </span>
      </label>
      <Help id={id.help} text={question.help} />
      <ErrorLine id={id.error} error={error} />
    </div>
  );
}
