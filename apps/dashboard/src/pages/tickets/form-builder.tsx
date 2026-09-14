import {
  FORM_FIELDS_MAX,
  type TicketFormField,
  type TicketType,
} from '@proton/module-tickets/config';
import type { ReactElement } from 'react';
import { CollectionHeader } from '../../components/ui/collection.tsx';
import {
  Badge,
  Button,
  Chip,
  IconButton,
  NumberStepper,
  SegmentedControl,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import { EmptyState } from '../../components/ui/feedback.tsx';
import { DetailField, ExpandableRow, Rows } from '../../components/ui/layout.tsx';
import {
  droppedSelect,
  duplicateOptionValues,
  FORM_STYLE_OPTIONS,
  moveInList,
  shownInModal,
  slugTyping,
  type TicketsForm,
  uniqueSlug,
} from './shape.ts';

const FIELD_ID_MAX = 32;
const LABEL_MAX = 45;
const PLACEHOLDER_MAX = 100;
const OPTION_MAX = 100;
const OPTIONS_MAX = 25;

const CEILING_NOTE = 'Discord allows up to 5 questions in a form.';

const EMPTY = 'Add a question to ask members before their ticket opens.';

const FIRST_ANSWER = 'The first answer becomes the ticket’s subject, which the queue searches.';

const EMPTY_SELECT =
  'A dropdown with no choices is left out of the form. Add a choice or change the style.';

const DUPLICATE_VALUE = 'Two choices share a value. Discord refuses the form.';

const ID_FIXED =
  'Answers already saved are stored under this ID. Changing it separates them from this question.';

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

const ID_SHAPE =
  'a form field id is letters, digits, dots, dashes and underscores, starting with a letter or digit.';

function blankField(taken: ReadonlySet<string>, index: number): TicketFormField {
  return {
    id: uniqueSlug(`question-${index + 1}`, taken, FIELD_ID_MAX),
    label: '',
    style: 'short',
    required: true,
    options: [],
  };
}

export function FormBuilder({
  form,
  type,
  index,
}: {
  form: TicketsForm;
  type: TicketType;
  index: number;
}): ReactElement {
  const fields = type.form;
  const taken = new Set(fields.map((field) => field.id));
  const full = fields.length >= FORM_FIELDS_MAX;

  const setFields = (next: TicketFormField[]): void => {
    form.setValue((current) => ({
      ...current,
      types: current.types.map((candidate, at) =>
        at === index ? { ...candidate, form: next } : candidate,
      ),
    }));
  };

  const patch = (at: number, change: Partial<TicketFormField>): void =>
    setFields(fields.map((field, position) => (position === at ? { ...field, ...change } : field)));

  return (
    <>
      <CollectionHeader
        title="Questions"
        used={fields.length}
        ceiling={FORM_FIELDS_MAX}
        limitLabel="questions"
        actions={
          <Button
            icon="plus"
            disabled={full}
            title={full ? CEILING_NOTE : undefined}
            onClick={() => setFields([...fields, blankField(taken, fields.length)])}
          >
            Add question
          </Button>
        }
      />

      <p className="tickets-ceiling-note">{CEILING_NOTE}</p>

      {fields.length === 0 ? (
        <EmptyState icon="list-checks" title="No questions" inset>
          {EMPTY}
        </EmptyState>
      ) : (
        <Rows>
          {fields.map((field, at) => {
            const shown = shownInModal(type, field);
            const empty = droppedSelect(field);
            const duplicated = duplicateOptionValues(field);
            const path = `types.${index}.form.${at}`;

            const idClash = fields.some(
              (other, position) => position !== at && other.id === field.id,
            );

            const labelError =
              field.label.trim() === ''
                ? 'Question cannot be empty. Members see it in the form.'
                : form.errorAt(`${path}.label`);

            const idError = idClash
              ? 'Another question already has this ID.'
              : !SLUG.test(field.id)
                ? ID_SHAPE
                : form.errorAt(`${path}.id`);

            return (
              <ExpandableRow
                // biome-ignore lint/suspicious/noArrayIndexKey: a question's position is its identity, and its id is editable
                key={at}
                icon={field.style === 'select' ? 'list-checks' : 'chat-centered-text'}
                title={field.label.trim() === '' ? 'Untitled question' : field.label}
                description={at === 0 ? FIRST_ANSWER : undefined}
                badge={
                  <>
                    <Chip className="mono">{field.id}</Chip>
                    <Badge tone={field.required ? 'primary' : 'neutral'}>
                      {field.required ? 'Required' : 'Optional'}
                    </Badge>
                    {empty ? <Badge tone="danger">No choices</Badge> : null}
                    {!empty && !shown ? <Badge tone="warning">Not shown</Badge> : null}
                    {duplicated ? <Badge tone="danger">Duplicate choice</Badge> : null}
                  </>
                }
                control={
                  <>
                    <IconButton
                      icon="caret-up"
                      tone="ghost"
                      size="sm"
                      label={`Move ${field.label || field.id} up`}
                      disabled={at === 0}
                      onClick={() => setFields(moveInList(fields, at, at - 1))}
                    />
                    <IconButton
                      icon="caret-down"
                      tone="ghost"
                      size="sm"
                      label={`Move ${field.label || field.id} down`}
                      disabled={at === fields.length - 1}
                      onClick={() => setFields(moveInList(fields, at, at + 1))}
                    />
                    <IconButton
                      icon="trash"
                      tone="ghost"
                      size="sm"
                      label={`Remove ${field.label || field.id}`}
                      onClick={() => setFields(fields.filter((_, position) => position !== at))}
                    />
                  </>
                }
                detail={() => (
                  <>
                    {empty ? <p className="row-error">{EMPTY_SELECT}</p> : null}
                    {duplicated ? <p className="row-error">{DUPLICATE_VALUE}</p> : null}

                    <DetailField label="Question">
                      <TextInput
                        width="lg"
                        aria-label="Question"
                        maxLength={LABEL_MAX}
                        invalid={labelError !== undefined}
                        value={field.label}
                        onChange={(event) => patch(at, { label: event.currentTarget.value })}
                      />
                    </DetailField>
                    {labelError !== undefined ? <p className="row-error">{labelError}</p> : null}

                    <DetailField label="ID">
                      <TextInput
                        width="sm"
                        className="mono"
                        aria-label="Question ID"
                        spellCheck={false}
                        maxLength={FIELD_ID_MAX}
                        invalid={idError !== undefined}
                        value={field.id}
                        onChange={(event) =>
                          patch(at, { id: slugTyping(event.currentTarget.value, FIELD_ID_MAX) })
                        }
                      />
                    </DetailField>
                    <p
                      className={
                        idError === undefined ? 'row-note tickets-detail-note' : 'row-error'
                      }
                    >
                      {idError ?? ID_FIXED}
                    </p>

                    <DetailField label="Style">
                      <SegmentedControl
                        label="Style"
                        options={FORM_STYLE_OPTIONS}
                        value={field.style}
                        onChange={(next) => patch(at, { style: next })}
                      />
                    </DetailField>

                    <DetailField label="Required">
                      <Switch
                        label="Required"
                        checked={field.required}
                        onChange={(next) => patch(at, { required: next })}
                      />
                    </DetailField>

                    <DetailField label="Placeholder">
                      <TextInput
                        width="lg"
                        aria-label="Placeholder"
                        maxLength={PLACEHOLDER_MAX}
                        value={field.placeholder ?? ''}
                        onChange={(event) =>
                          patch(at, {
                            placeholder:
                              event.currentTarget.value === ''
                                ? undefined
                                : event.currentTarget.value,
                          })
                        }
                      />
                    </DetailField>

                    {field.style === 'select' ? (
                      <ChoiceList field={field} onChange={(options) => patch(at, { options })} />
                    ) : (
                      <>
                        <DetailField label="Maximum length">
                          <NumberStepper
                            label="Maximum length"
                            min={1}
                            max={4000}
                            value={field.maxLength ?? null}
                            onChange={(next) => patch(at, { maxLength: next ?? undefined })}
                          />
                        </DetailField>
                        <p className="row-note tickets-detail-note">
                          Leave empty to allow up to {field.style === 'paragraph' ? '1024' : '200'}{' '}
                          characters.
                        </p>
                      </>
                    )}
                  </>
                )}
              />
            );
          })}
        </Rows>
      )}
    </>
  );
}

function ChoiceList({
  field,
  onChange,
}: {
  field: TicketFormField;
  onChange: (options: TicketFormField['options']) => void;
}): ReactElement {
  const options = field.options;
  const full = options.length >= OPTIONS_MAX;

  return (
    <div className="stack stack-8 tickets-choices">
      <div className="inline inline-8">
        <span className="row-detail-label">Choices</span>
        <span className="text-xs text-muted">
          {options.length} / {OPTIONS_MAX}
        </span>
      </div>

      {options.map((option, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a choice's position is its identity and its value is editable
        <div className="inline inline-8" key={at}>
          <TextInput
            width="md"
            aria-label={`Choice ${at + 1} label`}
            placeholder="Shown to members"
            maxLength={OPTION_MAX}
            invalid={option.label.trim() === ''}
            value={option.label}
            onChange={(event) =>
              onChange(
                options.map((current, position) =>
                  position === at ? { ...current, label: event.currentTarget.value } : current,
                ),
              )
            }
          />
          <TextInput
            width="sm"
            className="mono"
            aria-label={`Choice ${at + 1} value`}
            placeholder="Saved value"
            spellCheck={false}
            maxLength={OPTION_MAX}
            invalid={
              option.value.trim() === '' ||
              options.some((other, position) => position !== at && other.value === option.value)
            }
            value={option.value}
            onChange={(event) =>
              onChange(
                options.map((current, position) =>
                  position === at ? { ...current, value: event.currentTarget.value } : current,
                ),
              )
            }
          />
          <IconButton
            icon="trash"
            tone="ghost"
            size="sm"
            label={`Remove choice ${at + 1}`}
            onClick={() => onChange(options.filter((_, position) => position !== at))}
          />
        </div>
      ))}

      <div>
        <Button
          size="sm"
          icon="plus"
          disabled={full}
          onClick={() => onChange([...options, { label: '', value: '' }])}
        >
          Add choice
        </Button>
      </div>
    </div>
  );
}
