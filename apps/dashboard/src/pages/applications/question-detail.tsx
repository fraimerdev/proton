import {
  isHostName,
  QUESTION_TYPES,
  type Question,
  type QuestionType,
  questionsOf,
  type Section,
} from '@proton/module-applications/config';
import {
  OPTION_DESCRIPTION_MAX,
  OPTION_LABEL_MAX,
  OPTION_VALUE_MAX,
  OPTIONS_MAX,
  QUESTION_HELP_MAX,
  QUESTION_ID_MAX,
  QUESTION_LABEL_MAX,
  QUESTION_PLACEHOLDER_MAX,
  RADIO_OPTIONS_MAX,
  TEXT_ANSWER_MAX,
} from '@proton/module-applications/constants';
import type { ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Chip,
  cx,
  IconButton,
  NumberStepper,
  Select,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { HelpTip, Popover } from '../../components/ui/overlay.tsx';
import {
  changeType,
  conditionSources,
  FILE_TYPE,
  type IssueMap,
  idProblem,
  isChoice,
  issuesUnder,
  moveInList,
  optionValueFor,
  QUESTION_TYPE_LABELS,
  type QuestionAt,
  questionTitle,
  relabelOption,
  slugTyping,
  sourceChoices,
  TEXT_TYPES,
  withOptional,
} from './shape.ts';

const FILE_HELP =
  'File upload isn’t available. Proton doesn’t store files, so ask for a link instead with a ' +
  'Link question.';

const LABEL_HINT = 'Discord shows at most 45 characters.';

const ID_HINT = 'Answers are stored under this ID. Keep it once the form is published.';

const BRANCH_RULE =
  'Otherwise the question is skipped. A skipped question never blocks sending, and any answer ' +
  'it had is left out.';

const NO_SOURCES =
  'To show this only for some answers, put a choice or confirmation question before it.';

const HOSTS_HINT = 'Leave empty to accept links to any site.';

const TYPE_OPTIONS = [
  ...QUESTION_TYPES.map((type) => ({ value: type, label: QUESTION_TYPE_LABELS[type] })),
  { value: FILE_TYPE, label: 'File upload (not available)', disabled: true },
];

export function DetailBox({
  label,
  help,
  error,
  hint,
  wide = false,
  full = false,
  children,
}: {
  label: string;
  help?: ReactNode;
  error?: string | undefined;
  hint?: ReactNode;
  wide?: boolean | undefined;
  full?: boolean | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cx(
        'row-detail-field',
        wide && 'applications-field-wide',
        full && 'applications-field-full',
      )}
    >
      <span className="row-detail-label applications-detail-label">
        {label}
        {help !== undefined ? <HelpTip label={label}>{help}</HelpTip> : null}
      </span>
      {children}
      {error !== undefined ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint !== undefined ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function ChipPicker({
  value,
  options,
  onChange,
  addLabel,
  empty,
  removable = true,
}: {
  value: readonly string[];
  options: readonly { value: string; label: string }[];
  onChange: (next: string[]) => void;
  addLabel: string;
  empty?: string | undefined;
  removable?: boolean | undefined;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const labels = new Map(options.map((option) => [option.value, option.label]));
  const remaining = options.filter((option) => !value.includes(option.value));

  return (
    <div className="chip-list">
      {value.map((key) => (
        <Chip
          key={key}
          removeLabel={`Remove ${labels.get(key) ?? key}`}
          onRemove={removable ? () => onChange(value.filter((entry) => entry !== key)) : undefined}
        >
          {labels.get(key) ?? key}
        </Chip>
      ))}

      <button
        ref={anchor}
        type="button"
        className="chip-add"
        disabled={remaining.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={addLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="plus" size={14} />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={220}
        maxWidth={320}
      >
        <div className="popover-scroll" role="listbox" aria-label={addLabel}>
          {remaining.length === 0 ? (
            <p className="picker-note">{empty ?? 'Nothing left to add'}</p>
          ) : null}
          {remaining.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={false}
              className="picker-option"
              onClick={() => {
                onChange([...value, option.value]);
                setOpen(false);
              }}
            >
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function OptionsEditor({
  question,
  onChange,
  problems,
}: {
  question: Question;
  onChange: (next: Question) => void;
  problems: readonly string[];
}): ReactElement {
  const options = question.options;
  const full = options.length >= OPTIONS_MAX;

  const setOptions = (next: Question['options']): void => onChange({ ...question, options: next });

  const add = (): void => {
    const taken = new Set(options.map((option) => option.value));
    const label = `Option ${options.length + 1}`;
    setOptions([...options, { label, value: optionValueFor(label, taken), description: '' }]);
  };

  const dropdown = options.length > RADIO_OPTIONS_MAX;

  return (
    <div className="applications-field-full stack stack-8">
      <span className="row-detail-label">
        Options{' '}
        <span className="text-muted">
          {options.length} / {OPTIONS_MAX}
        </span>
      </span>

      <div className="applications-options">
        {options.map((option, at) => {
          const clash = options.some((other, spot) => spot !== at && other.value === option.value);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: an option's value is editable, so its position is its identity here
            <div className="applications-option" key={at}>
              <TextInput
                width="md"
                aria-label={`Option ${at + 1}`}
                placeholder="Shown to applicants"
                maxLength={OPTION_LABEL_MAX}
                invalid={option.label.trim() === ''}
                value={option.label}
                onChange={(event) =>
                  setOptions(relabelOption(options, at, event.currentTarget.value))
                }
              />
              <TextInput
                width="sm"
                className="mono"
                spellCheck={false}
                aria-label={`Option ${at + 1} saved value`}
                placeholder="Saved value"
                maxLength={OPTION_VALUE_MAX}
                invalid={clash || option.value.trim() === ''}
                value={option.value}
                onChange={(event) =>
                  setOptions(
                    options.map((current, spot) =>
                      spot === at
                        ? {
                            ...current,
                            value: slugTyping(event.currentTarget.value, OPTION_VALUE_MAX),
                          }
                        : current,
                    ),
                  )
                }
              />
              <TextInput
                width="md"
                aria-label={`Option ${at + 1} description`}
                placeholder="Description (optional)"
                maxLength={OPTION_DESCRIPTION_MAX}
                value={option.description}
                onChange={(event) =>
                  setOptions(
                    options.map((current, spot) =>
                      spot === at
                        ? { ...current, description: event.currentTarget.value }
                        : current,
                    ),
                  )
                }
              />
              <span className="applications-option-controls">
                <IconButton
                  tone="ghost"
                  size="sm"
                  icon="caret-up"
                  label={`Move ${option.label || `option ${at + 1}`} up`}
                  disabled={at === 0}
                  onClick={() => setOptions(moveInList(options, at, at - 1))}
                />
                <IconButton
                  tone="ghost"
                  size="sm"
                  icon="caret-down"
                  label={`Move ${option.label || `option ${at + 1}`} down`}
                  disabled={at === options.length - 1}
                  onClick={() => setOptions(moveInList(options, at, at + 1))}
                />
                <IconButton
                  tone="danger-quiet"
                  size="sm"
                  icon="trash"
                  label={`Remove ${option.label || `option ${at + 1}`}`}
                  onClick={() => setOptions(options.filter((_, spot) => spot !== at))}
                />
              </span>
            </div>
          );
        })}
      </div>

      {problems.map((problem) => (
        <span key={problem} className="field-error" role="alert">
          {problem}
        </span>
      ))}

      <div className="inline inline-8 inline-wrap">
        <Button size="sm" icon="plus" disabled={full} onClick={add}>
          Add option
        </Button>
        <span className="text-xs text-muted">
          {full
            ? `A question can have up to ${OPTIONS_MAX} options.`
            : dropdown
              ? `With more than ${RADIO_OPTIONS_MAX} options, Discord shows a dropdown instead of ${question.type === 'multiple' ? 'checkboxes' : 'radio buttons'}.`
              : `Up to ${RADIO_OPTIONS_MAX} options show as ${question.type === 'multiple' ? 'checkboxes' : 'radio buttons'} in Discord. More become a dropdown.`}
        </span>
      </div>
    </div>
  );
}

function ConditionEditor({
  question,
  sections,
  onChange,
  problems,
}: {
  question: Question;
  sections: readonly Section[];
  onChange: (next: Question) => void;
  problems: readonly string[];
}): ReactElement {
  const sources = conditionSources(sections, question.id);
  const condition = question.showIf;
  const flat = questionsOf({ sections });
  const source =
    condition === undefined
      ? undefined
      : flat.find((candidate) => candidate.id === condition.questionId);

  const listed = sources.some((candidate) => candidate.id === condition?.questionId);
  const options = [
    { value: '', label: 'Always show' },
    ...sources.map((candidate) => ({ value: candidate.id, label: questionTitle(candidate) })),
    ...(condition !== undefined && !listed
      ? [
          {
            value: condition.questionId,
            label:
              source === undefined
                ? condition.questionId
                : `${questionTitle(source)} (not allowed)`,
          },
        ]
      : []),
  ];

  const pick = (id: string): void => {
    if (id === '') {
      onChange(withOptional(question, 'showIf', undefined));
      return;
    }
    const chosen = flat.find((candidate) => candidate.id === id);
    const first = chosen === undefined ? undefined : sourceChoices(chosen)[0]?.value;
    onChange({
      ...question,
      showIf: { questionId: id, values: first === undefined ? [] : [first] },
    });
  };

  return (
    <DetailBox label="Show only when" full>
      {sources.length === 0 && condition === undefined ? (
        <span className="text-sm text-muted">{NO_SOURCES}</span>
      ) : (
        <div className="stack stack-8">
          <div className="inline inline-8 inline-wrap">
            <Select
              width="lg"
              aria-label="Show only when"
              options={options}
              value={condition?.questionId ?? ''}
              onChange={pick}
            />
            {condition !== undefined && source !== undefined && source.type === 'confirm' ? (
              <span className="text-sm text-secondary">is ticked</span>
            ) : null}
          </div>

          {condition !== undefined && source !== undefined && source.type !== 'confirm' ? (
            <div className="inline inline-8 inline-wrap">
              <span className="text-sm text-secondary">is any of</span>
              <ChipPicker
                value={condition.values}
                options={sourceChoices(source)}
                addLabel="Add an answer"
                empty="Every answer is already listed"
                removable={condition.values.length > 1}
                onChange={(values) => onChange({ ...question, showIf: { ...condition, values } })}
              />
            </div>
          ) : null}

          {condition !== undefined ? <span className="field-hint">{BRANCH_RULE}</span> : null}
        </div>
      )}
      {problems.map((problem) => (
        <span key={problem} className="field-error" role="alert">
          {problem}
        </span>
      ))}
    </DetailBox>
  );
}

function HostsEditor({
  question,
  onChange,
  problems,
}: {
  question: Question;
  onChange: (next: Question) => void;
  problems: readonly string[];
}): ReactElement {
  const [draft, setDraft] = useState('');
  const host = draft
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const invalid = host !== '' && !isHostName(host);
  const full = question.hosts.length >= 20;

  const add = (): void => {
    if (host === '' || invalid || question.hosts.includes(host)) return;
    onChange({ ...question, hosts: [...question.hosts, host] });
    setDraft('');
  };

  return (
    <DetailBox
      label="Allowed sites"
      wide
      error={invalid ? 'Enter a domain like github.com.' : problems[0]}
      hint={HOSTS_HINT}
    >
      <div className="stack stack-8">
        {question.hosts.length > 0 ? (
          <div className="chip-list">
            {question.hosts.map((entry) => (
              <Chip
                key={entry}
                className="mono"
                removeLabel={`Remove ${entry}`}
                onRemove={() =>
                  onChange({ ...question, hosts: question.hosts.filter((h) => h !== entry) })
                }
              >
                {entry}
              </Chip>
            ))}
          </div>
        ) : null}
        <span className="inline inline-6">
          <TextInput
            width="md"
            aria-label="Add an allowed site"
            placeholder="github.com"
            spellCheck={false}
            disabled={full}
            invalid={invalid}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
          />
          <Button size="sm" disabled={full || host === '' || invalid} onClick={add}>
            Add
          </Button>
        </span>
      </div>
    </DetailBox>
  );
}

function optionalNumber(value: number | null): number | undefined {
  return value === null || !Number.isFinite(value) ? undefined : value;
}

export function QuestionDetail({
  question,
  at,
  sections,
  issues,
  serverError,
  takenIds,
  onChange,
  onMoveToSection,
}: {
  question: Question;
  at: QuestionAt;
  sections: readonly Section[];
  issues: IssueMap;
  serverError: (subpath: string) => string | undefined;
  takenIds: ReadonlySet<string>;
  onChange: (next: Question) => void;
  onMoveToSection: (section: number) => void;
}): ReactElement {
  const prefix = `sections.${at.section}.questions.${at.index}`;
  const issue = (sub: string): string | undefined =>
    issues.get(`${prefix}.${sub}`) ?? serverError(sub);
  const under = (sub: string): string[] => {
    const local = issuesUnder(issues, `${prefix}.${sub}`);
    const remote = serverError(sub);
    return remote !== undefined && !local.includes(remote) ? [...local, remote] : local;
  };

  const labelError = question.label.trim() === '' ? 'A question needs text.' : issue('label');
  const idError = idProblem(question.id, takenIds, 'question') ?? issue('id');
  const type = question.type;
  const set = <K extends keyof Question & string>(key: K, value: Question[K] | undefined): void =>
    onChange(withOptional(question, key, value));

  return (
    <>
      <DetailBox label="Type" help={FILE_HELP}>
        <Select
          width="md"
          aria-label="Question type"
          options={TYPE_OPTIONS}
          value={type}
          onChange={(next) => {
            if ((QUESTION_TYPES as readonly string[]).includes(next)) {
              onChange(changeType(question, next as QuestionType));
            }
          }}
        />
      </DetailBox>

      <DetailBox
        label="Question"
        wide
        error={labelError}
        hint={`${question.label.length} / ${QUESTION_LABEL_MAX}. ${LABEL_HINT}`}
      >
        <TextInput
          width="full"
          aria-label="Question"
          maxLength={QUESTION_LABEL_MAX}
          invalid={labelError !== undefined}
          value={question.label}
          onChange={(event) => onChange({ ...question, label: event.currentTarget.value })}
        />
      </DetailBox>

      <DetailBox label="ID" error={idError} hint={ID_HINT}>
        <TextInput
          width="sm"
          className="mono"
          spellCheck={false}
          aria-label="Question ID"
          maxLength={QUESTION_ID_MAX}
          invalid={idError !== undefined}
          value={question.id}
          onChange={(event) =>
            onChange({ ...question, id: slugTyping(event.currentTarget.value, QUESTION_ID_MAX) })
          }
        />
      </DetailBox>

      <DetailBox
        label="Help text"
        wide
        error={issue('help')}
        hint={`${question.help.length} / ${QUESTION_HELP_MAX}. Shown under the question.`}
      >
        <TextInput
          width="full"
          aria-label="Help text"
          maxLength={QUESTION_HELP_MAX}
          value={question.help}
          onChange={(event) => onChange({ ...question, help: event.currentTarget.value })}
        />
      </DetailBox>

      {TEXT_TYPES.includes(type) || type === 'number' || type === 'url' ? (
        <DetailBox
          label="Placeholder"
          wide
          error={issue('placeholder')}
          hint="Shown in the empty answer box."
        >
          <TextInput
            width="full"
            aria-label="Placeholder"
            maxLength={QUESTION_PLACEHOLDER_MAX}
            value={question.placeholder}
            onChange={(event) => onChange({ ...question, placeholder: event.currentTarget.value })}
          />
        </DetailBox>
      ) : null}

      <DetailBox
        label="Required"
        hint={type === 'confirm' ? 'On: they have to tick it to send.' : undefined}
      >
        <Switch
          label="Required"
          checked={question.required}
          onChange={(next) => onChange({ ...question, required: next })}
        />
      </DetailBox>

      {TEXT_TYPES.includes(type) ? (
        <>
          <DetailBox
            label="Shortest answer"
            error={issue('minLength')}
            hint="Characters. Empty for none."
          >
            <NumberStepper
              label="Shortest answer"
              width={128}
              min={0}
              max={TEXT_ANSWER_MAX}
              value={question.minLength ?? null}
              invalid={issue('minLength') !== undefined}
              onChange={(next) => set('minLength', optionalNumber(next))}
            />
          </DetailBox>
          <DetailBox
            label="Longest answer"
            error={issue('maxLength')}
            hint={`Characters, up to ${TEXT_ANSWER_MAX}.`}
          >
            <NumberStepper
              label="Longest answer"
              width={128}
              min={1}
              max={TEXT_ANSWER_MAX}
              value={question.maxLength ?? null}
              invalid={issue('maxLength') !== undefined}
              onChange={(next) => set('maxLength', optionalNumber(next))}
            />
          </DetailBox>
        </>
      ) : null}

      {type === 'number' ? (
        <>
          <DetailBox label="Smallest" error={issue('min')} hint="Empty for no limit.">
            <NumberStepper
              label="Smallest number"
              width={128}
              value={question.min ?? null}
              invalid={issue('min') !== undefined}
              onChange={(next) => set('min', optionalNumber(next))}
            />
          </DetailBox>
          <DetailBox label="Largest" error={issue('max')} hint="Empty for no limit.">
            <NumberStepper
              label="Largest number"
              width={128}
              value={question.max ?? null}
              invalid={issue('max') !== undefined}
              onChange={(next) => set('max', optionalNumber(next))}
            />
          </DetailBox>
          <DetailBox label="Whole numbers only">
            <Switch
              label="Whole numbers only"
              checked={question.integer}
              onChange={(next) => onChange({ ...question, integer: next })}
            />
          </DetailBox>
        </>
      ) : null}

      {type === 'url' ? (
        <>
          <DetailBox label="Links starting with" error={under('schemes')[0]}>
            <span className="inline inline-12">
              {(['https', 'http'] as const).map((scheme) => {
                const checked = question.schemes.includes(scheme);
                const last = checked && question.schemes.length === 1;
                return (
                  <span key={scheme} className="inline inline-6 text-sm">
                    <Checkbox
                      label={`${scheme}://`}
                      checked={checked}
                      disabled={last}
                      onChange={(next) =>
                        onChange({
                          ...question,
                          schemes: next
                            ? [...question.schemes, scheme]
                            : question.schemes.filter((entry) => entry !== scheme),
                        })
                      }
                    />
                    <span className="mono">{scheme}://</span>
                  </span>
                );
              })}
            </span>
          </DetailBox>
          <HostsEditor question={question} onChange={onChange} problems={under('hosts')} />
        </>
      ) : null}

      {isChoice(type) ? (
        <OptionsEditor question={question} onChange={onChange} problems={under('options')} />
      ) : null}

      {type === 'multiple' ? (
        <>
          <DetailBox label="Fewest choices" error={issue('minChoices')} hint="Empty for none.">
            <NumberStepper
              label="Fewest choices"
              width={128}
              min={0}
              max={OPTIONS_MAX}
              value={question.minChoices ?? null}
              invalid={issue('minChoices') !== undefined}
              onChange={(next) => set('minChoices', optionalNumber(next))}
            />
          </DetailBox>
          <DetailBox label="Most choices" error={issue('maxChoices')} hint="Empty for no limit.">
            <NumberStepper
              label="Most choices"
              width={128}
              min={1}
              max={OPTIONS_MAX}
              value={question.maxChoices ?? null}
              invalid={issue('maxChoices') !== undefined}
              onChange={(next) => set('maxChoices', optionalNumber(next))}
            />
          </DetailBox>
        </>
      ) : null}

      <ConditionEditor
        question={question}
        sections={sections}
        onChange={onChange}
        problems={under('showIf')}
      />

      {sections.length > 1 ? (
        <DetailBox label="Section">
          <Select
            width="md"
            aria-label="Section"
            options={sections.map((section, spot) => ({
              value: String(spot),
              label: section.title.trim() === '' ? `Section ${spot + 1}` : section.title,
            }))}
            value={String(at.section)}
            onChange={(next) => {
              const target = Number(next);
              if (Number.isInteger(target) && target !== at.section) onMoveToSection(target);
            }}
          />
        </DetailBox>
      ) : null}
    </>
  );
}
