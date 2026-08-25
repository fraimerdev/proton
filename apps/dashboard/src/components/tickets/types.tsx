import type { EntitlementTier, TicketPriority } from '@proton/core';
import { TICKET_PRIORITIES, tryParseDuration } from '@proton/core';
import {
  blankType,
  CATEGORY_CHANNEL_TYPE,
  CHANNEL_NAME_MAX,
  CLAIM_MODES,
  type ClaimMode,
  FORM_FIELD_STYLES,
  FORM_FIELDS_MAX,
  type FormFieldStyle,
  NUMBER_PLACEHOLDER,
  PRIORITY_LABELS,
  TEXT_CHANNEL_TYPE,
  type TicketFormField,
  type TicketType,
  TRANSCRIPT_DESTINATIONS,
  type TranscriptDestination,
  TYPE_ID_MAX,
  TYPE_PLACEHOLDER,
  ticketFormFieldSchema,
  ticketTypesSchema,
  USER_PLACEHOLDER,
} from '@proton/module-tickets/config';
import { type ReactElement, useId, useState } from 'react';
import { ceilingNote, listCeiling } from '../../lib/limits.ts';
import {
  channelOptions,
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
  TokenPicker,
} from '../form/picker.tsx';
import { Icon } from '../shell/icon.tsx';

export interface TicketTypesEditorProps {
  types: readonly Partial<TicketType>[];
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  tier: EntitlementTier;
  onChange: (types: TicketType[]) => void;
}

const TYPE_DEFAULTS = blankType(0);

const FIELD_DEFAULTS = ticketFormFieldSchema.parse({ id: 'question', label: 'Question' });

// A stored row filled out to the current shape. The API parses config before it gets here, but a
// row that reached the editor unparsed would crash on `type.form` — and a settings page that throws
// is worse than one showing defaults it is about to save anyway.
function complete(type: Partial<TicketType>): TicketType {
  return {
    ...TYPE_DEFAULTS,
    ...type,
    id: type.id ?? '',
    staffRoleIds: type.staffRoleIds ?? [],
    form: (type.form ?? []).map((field) => ({ ...FIELD_DEFAULTS, ...field })),
  };
}

const CLAIM_LABELS: Record<ClaimMode, string> = {
  off: 'Nobody claims — every staff member handles every ticket',
  single: 'One claimer — the first to press Claim owns it',
  assignable: 'Assignable — a claimed ticket can be handed to somebody else',
};

const TRANSCRIPT_LABELS: Record<TranscriptDestination, string> = {
  off: 'Nowhere — the conversation is not kept once the channel goes',
  channel: 'The transcript channel',
  owner: 'A DM to the member who opened it',
  both: 'Both the transcript channel and the member',
};

const FIELD_STYLE_LABELS: Record<FormFieldStyle, string> = {
  short: 'One line',
  paragraph: 'Several lines',
  select: 'A dropdown of choices',
};

const FORM_OPTIONS_MAX = 25;

// Every sibling panel names the row that is wrong ("Creator channel 2: …"); a nested list without
// this prints the Zod path verbatim, so an admin reads "0.form.2.label: Required".
function describeIssuePath(path: readonly PropertyKey[]): string {
  if (typeof path[0] !== 'number') return '';
  const type = `Ticket type ${path[0] + 1}`;

  if (path[1] !== 'form' || typeof path[2] !== 'number') return `${type}: `;
  const question = `${type}, question ${path[2] + 1}`;

  return path[3] === 'options' && typeof path[4] === 'number'
    ? `${question}, choice ${path[4] + 1}: `
    : `${question}: `;
}

function summarise(type: TicketType, failed: boolean): string {
  if (failed) return 'not filled in';

  const parts = [type.id];
  if (type.form.length > 0) {
    parts.push(`${type.form.length} question${type.form.length === 1 ? '' : 's'}`);
  }
  if (type.captureMessages) parts.push('messages kept');

  return parts.join(' · ');
}

interface DurationInputProps {
  label: string;
  placeholder: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}

function DurationInput({ label, placeholder, value, onChange }: DurationInputProps): ReactElement {
  const errorId = useId();
  const [editing, setEditing] = useState(false);

  const text = value ?? '';

  // Suppressed while the box has focus: "3" is not a duration yet, and neither is "30".
  const invalid = text !== '' && !editing && tryParseDuration(text) === null;

  return (
    <label className="filter">
      <span>{label}</span>
      <input
        type="text"
        placeholder={placeholder}
        value={text}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
      {invalid ? (
        <span className="field-error" id={errorId} role="alert">
          “{text}” is not a duration. Use a number followed by s, m, h, d or w — 30m, 12h, 7d.
        </span>
      ) : null}
    </label>
  );
}

interface SwitchRowProps {
  label: string;
  description?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function SwitchRow({ label, description, checked, onChange }: SwitchRowProps): ReactElement {
  return (
    <label className="builder-switch">
      <span className="builder-switch-text">
        <span>{label}</span>
        {description ? <span className="field-description">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

interface FormFieldEditorProps {
  field: TicketFormField;
  index: number;
  onChange: (field: TicketFormField) => void;
  onRemove: () => void;
}

function FormFieldEditor({ field, index, onChange, onRemove }: FormFieldEditorProps): ReactElement {
  const options = field.options;

  return (
    <div className="builder-row">
      <span className="builder-head">
        <span className="builder-head-title">Question {index + 1}</span>
        <span className="builder-actions">
          <button
            type="button"
            className="button button-ghost"
            aria-label={`Remove question ${index + 1}`}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </span>
      </span>

      <label className="filter">
        <span>Asks</span>
        <input
          type="text"
          maxLength={45}
          value={field.label}
          aria-invalid={field.label.trim() === ''}
          onChange={(e) => onChange({ ...field, label: e.target.value })}
        />
      </label>

      <label className="filter">
        <span>Answer key</span>
        <input
          type="text"
          maxLength={32}
          value={field.id}
          aria-invalid={field.id === ''}
          onChange={(e) => onChange({ ...field, id: e.target.value })}
        />
      </label>

      <label className="filter">
        <span>Answered in</span>
        <select
          value={field.style}
          onChange={(e) => onChange({ ...field, style: e.target.value as FormFieldStyle })}
        >
          {FORM_FIELD_STYLES.map((style) => (
            <option key={style} value={style}>
              {FIELD_STYLE_LABELS[style]}
            </option>
          ))}
        </select>
      </label>

      <label className="filter">
        <span>Placeholder</span>
        <input
          type="text"
          maxLength={100}
          value={field.placeholder ?? ''}
          onChange={(e) =>
            onChange({
              ...field,
              placeholder: e.target.value === '' ? undefined : e.target.value,
            })
          }
        />
      </label>

      <label className="filter">
        <span>Longest answer</span>
        <input
          type="number"
          min={1}
          max={4000}
          placeholder="4000"
          value={field.maxLength ?? ''}
          onChange={(e) =>
            onChange({
              ...field,
              maxLength: e.target.value === '' ? undefined : e.target.valueAsNumber,
            })
          }
        />
      </label>

      <SwitchRow
        label="Must be answered"
        checked={field.required}
        onChange={(required) => onChange({ ...field, required })}
      />

      {field.style === 'select' ? (
        <>
          {options.map((option, optionIndex) => (
            <div
              className="ladder-rung"
              // biome-ignore lint/suspicious/noArrayIndexKey: both halves of a choice are edited here
              key={`option-${optionIndex}`}
            >
              <label className="filter">
                <span>Choice {optionIndex + 1}</span>
                <input
                  type="text"
                  maxLength={100}
                  value={option.label}
                  aria-invalid={option.label.trim() === ''}
                  onChange={(e) =>
                    onChange({
                      ...field,
                      options: options.map((held, i) =>
                        i === optionIndex ? { ...held, label: e.target.value } : held,
                      ),
                    })
                  }
                />
              </label>

              <label className="filter">
                <span>Recorded as</span>
                <input
                  type="text"
                  maxLength={100}
                  value={option.value}
                  aria-invalid={option.value.trim() === ''}
                  onChange={(e) =>
                    onChange({
                      ...field,
                      options: options.map((held, i) =>
                        i === optionIndex ? { ...held, value: e.target.value } : held,
                      ),
                    })
                  }
                />
              </label>

              <button
                type="button"
                className="button button-ghost"
                aria-label={`Remove choice ${optionIndex + 1} from question ${index + 1}`}
                onClick={() =>
                  onChange({ ...field, options: options.filter((_, i) => i !== optionIndex) })
                }
              >
                Remove choice
              </button>
            </div>
          ))}

          {options.length === 0 ? (
            <p className="field-empty">
              A dropdown with no choices cannot be shown, so this question would be dropped from the
              form.
            </p>
          ) : null}

          <button
            type="button"
            className="button button-quiet"
            disabled={options.length >= FORM_OPTIONS_MAX}
            onClick={() =>
              onChange({
                ...field,
                options: [
                  ...options,
                  { label: `Choice ${options.length + 1}`, value: `choice-${options.length + 1}` },
                ],
              })
            }
          >
            {options.length >= FORM_OPTIONS_MAX
              ? `Limit of ${FORM_OPTIONS_MAX} choices reached`
              : 'Add choice'}
          </button>
        </>
      ) : null}
    </div>
  );
}

interface TypeDetailProps {
  type: TicketType;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
  onChange: (patch: Partial<TicketType>) => void;
  onRemove: () => void;
}

function TypeDetail({ type, channels, roles, onChange, onRemove }: TypeDetailProps): ReactElement {
  const fieldId = useId();

  // A label wrapping the picker would forward option clicks back to the trigger and reopen it.
  const id = (part: string): string => `${fieldId}-${part}`;

  const categoryChoices = channelOptions(channels, [CATEGORY_CHANNEL_TYPE]);
  const textChoices = channelOptions(channels, [TEXT_CHANNEL_TYPE]);

  return (
    <div className="pane-edit">
      <div className="pane-edit-head">
        <span className="builder-head-title">{type.name || 'Unnamed ticket type'}</span>
        <span className="builder-actions">
          <button
            type="button"
            className="button button-ghost"
            aria-label={`Remove the ${type.name || 'unnamed'} ticket type`}
            onClick={onRemove}
          >
            <Icon name="trash" />
          </button>
        </span>
      </div>

      <fieldset className="builder-section">
        <legend>Identity</legend>

        <label className="filter">
          <span>Name</span>
          <input
            type="text"
            maxLength={64}
            value={type.name}
            aria-invalid={type.name.trim() === ''}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>

        <label className="filter">
          <span>Id</span>
          <input
            type="text"
            maxLength={TYPE_ID_MAX}
            value={type.id}
            aria-invalid={type.id === ''}
            onChange={(e) => onChange({ id: e.target.value })}
          />
          <small className="field-description">
            What a panel button carries back to Proton. Renaming it stops presses on a panel already
            posted until it is posted again.
          </small>
        </label>

        <label className="filter">
          <span>Emoji</span>
          <input
            type="text"
            maxLength={64}
            value={type.emoji ?? ''}
            onChange={(e) =>
              onChange({ emoji: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>

        <label className="filter">
          <span>Description</span>
          <input
            type="text"
            maxLength={100}
            placeholder="Shown beside the name on a dropdown panel"
            value={type.description ?? ''}
            onChange={(e) =>
              onChange({ description: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </label>
      </fieldset>

      <fieldset className="builder-section">
        <legend>Routing</legend>

        <div className="filter">
          <span>
            <label htmlFor={id('category')}>Tickets open in</label>
          </span>
          <SinglePicker
            id={id('category')}
            label="Tickets open in"
            options={categoryChoices}
            value={type.categoryId ?? null}
            onChange={(next) => onChange({ categoryId: next ?? undefined })}
            emptyLabel="No category"
            clearable
          />
        </div>

        <div className="filter">
          <span>
            <label htmlFor={id('archive')}>Closed tickets move to</label>
          </span>
          <SinglePicker
            id={id('archive')}
            label="Closed tickets move to"
            options={categoryChoices}
            value={type.archiveCategoryId ?? null}
            onChange={(next) => onChange({ archiveCategoryId: next ?? undefined })}
            emptyLabel="They stay where they are"
            clearable
          />
        </div>

        <div className="filter">
          <span>Staff for this kind of ticket</span>
          <TokenPicker
            label="Staff for this kind of ticket"
            options={roleOptions(roles)}
            values={type.staffRoleIds}
            max={20}
            onChange={(staffRoleIds) => onChange({ staffRoleIds })}
          />
          <small className="field-description">
            Added to the support roles set for the whole module, never instead of them.
          </small>
        </div>

        <label className="filter">
          <span>Channel name</span>
          <input
            type="text"
            maxLength={CHANNEL_NAME_MAX}
            placeholder="Falls back to the module’s pattern"
            value={type.namePattern ?? ''}
            onChange={(e) =>
              onChange({ namePattern: e.target.value === '' ? undefined : e.target.value })
            }
          />
          <small className="field-description">
            {NUMBER_PLACEHOLDER}, {USER_PLACEHOLDER} and {TYPE_PLACEHOLDER} are replaced.
          </small>
        </label>
      </fieldset>

      <fieldset className="builder-section">
        <legend>Intake</legend>

        <p className="field-description">
          Up to {FORM_FIELDS_MAX} questions, asked before the ticket is opened. The answers are
          posted into the ticket.
        </p>

        {type.form.map((field, fieldIndex) => (
          <FormFieldEditor
            field={field}
            index={fieldIndex}
            // biome-ignore lint/suspicious/noArrayIndexKey: the id field is itself edited here
            key={`question-${fieldIndex}`}
            onChange={(next) =>
              onChange({ form: type.form.map((held, i) => (i === fieldIndex ? next : held)) })
            }
            onRemove={() => onChange({ form: type.form.filter((_, i) => i !== fieldIndex) })}
          />
        ))}

        {type.form.length === 0 ? (
          <p className="field-empty">
            No questions. Pressing the panel button opens the channel straight away.
          </p>
        ) : null}

        <button
          type="button"
          className="button button-quiet"
          disabled={type.form.length >= FORM_FIELDS_MAX}
          onClick={() =>
            onChange({
              form: [
                ...type.form,
                ticketFormFieldSchema.parse({
                  id: `question-${type.form.length + 1}`,
                  label: 'What do you need help with?',
                }),
              ],
            })
          }
        >
          {type.form.length >= FORM_FIELDS_MAX
            ? `Limit of ${FORM_FIELDS_MAX} questions reached`
            : 'Add question'}
        </button>

        <SwitchRow
          label="Ask how urgent it is"
          checked={type.askPriority}
          onChange={(askPriority) => onChange({ askPriority })}
        />

        <label className="filter">
          <span>Urgency when nobody picks one</span>
          <select
            value={type.defaultPriority}
            onChange={(e) => onChange({ defaultPriority: e.target.value as TicketPriority })}
          >
            {TICKET_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>

        <label className="filter">
          <span>First message in the ticket</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={type.welcomeMessage}
            aria-invalid={type.welcomeMessage.trim() === ''}
            onChange={(e) => onChange({ welcomeMessage: e.target.value })}
          />
          <small className="field-description">
            {USER_PLACEHOLDER} is replaced with a mention of whoever opened it.
          </small>
        </label>

        <SwitchRow
          label="Ping the staff roles on that message"
          checked={type.mentionStaffOnOpen}
          onChange={(mentionStaffOnOpen) => onChange({ mentionStaffOnOpen })}
        />
      </fieldset>

      <fieldset className="builder-section">
        <legend>Handling</legend>

        <label className="filter">
          <span>Claiming</span>
          <select
            value={type.claimMode}
            onChange={(e) => onChange({ claimMode: e.target.value as ClaimMode })}
          >
            {CLAIM_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {CLAIM_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        {type.claimMode === 'off' ? null : (
          <SwitchRow
            label="Only the claimer may act on it"
            description="Other staff can still read the channel; the ticket commands refuse them."
            checked={type.claimRestrictsReplies}
            onChange={(claimRestrictsReplies) => onChange({ claimRestrictsReplies })}
          />
        )}
      </fieldset>

      <fieldset className="builder-section">
        <legend>Lifecycle</legend>

        <SwitchRow
          label="Staff must ask the member before closing"
          description="The member gets a confirm button. Closing their own ticket never asks."
          checked={type.closeRequiresConfirmation}
          onChange={(closeRequiresConfirmation) => onChange({ closeRequiresConfirmation })}
        />

        {type.closeRequiresConfirmation ? (
          <DurationInput
            label="That request expires after"
            placeholder="e.g. 24h — leave empty and it waits"
            value={type.closeRequestExpiresAfter}
            onChange={(closeRequestExpiresAfter) => onChange({ closeRequestExpiresAfter })}
          />
        ) : null}

        <SwitchRow
          label="A closed ticket can be reopened"
          checked={type.reopenEnabled}
          onChange={(reopenEnabled) => onChange({ reopenEnabled })}
        />

        <SwitchRow
          label="Move it to the archive category when it closes"
          checked={type.archiveOnClose}
          onChange={(archiveOnClose) => onChange({ archiveOnClose })}
        />

        <DurationInput
          label="Warn about silence after"
          placeholder="e.g. 24h — leave empty for no warning"
          value={type.inactivityWarnAfter}
          onChange={(inactivityWarnAfter) => onChange({ inactivityWarnAfter })}
        />

        <DurationInput
          label="Close after no reply for"
          placeholder="e.g. 48h — leave empty to never close on its own"
          value={type.autoCloseAfter}
          onChange={(autoCloseAfter) => onChange({ autoCloseAfter })}
        />

        <DurationInput
          label="Delete the channel after closing for"
          placeholder="e.g. 7d — leave empty to keep the channel"
          value={type.autoDeleteAfter}
          onChange={(autoDeleteAfter) => onChange({ autoDeleteAfter })}
        />
      </fieldset>

      <fieldset className="builder-section">
        <legend>Records</legend>

        <label className="filter">
          <span>A closed ticket’s transcript goes to</span>
          <select
            value={type.transcript}
            onChange={(e) => onChange({ transcript: e.target.value as TranscriptDestination })}
          >
            {TRANSCRIPT_DESTINATIONS.map((destination) => (
              <option key={destination} value={destination}>
                {TRANSCRIPT_LABELS[destination]}
              </option>
            ))}
          </select>
        </label>

        {type.transcript === 'channel' || type.transcript === 'both' ? (
          <div className="filter">
            <span>
              <label htmlFor={id('transcript')}>The transcript channel</label>
            </span>
            <SinglePicker
              id={id('transcript')}
              label="The transcript channel"
              options={textChoices}
              value={type.transcriptChannelId ?? null}
              onChange={(next) => onChange({ transcriptChannelId: next ?? undefined })}
              emptyLabel="The module’s transcript channel"
              clearable
            />
          </div>
        ) : null}

        <SwitchRow
          label="Keep the text of every message sent in these tickets"
          description={
            'Off unless you turn it on. It stores what every member writes in a ticket of this ' +
            'kind — text, attachments, edits and deletions — for 30 days, so a transcript can be ' +
            'rebuilt after the channel is gone. Without it a transcript lists who took part and ' +
            'what they answered, but not what was said. This is a decision about your members’ ' +
            'messages, so leave it off unless somebody has asked for it.'
          }
          checked={type.captureMessages}
          onChange={(captureMessages) => onChange({ captureMessages })}
        />

        <SwitchRow
          label="DM the member for a rating when it closes"
          checked={type.askRating}
          onChange={(askRating) => onChange({ askRating })}
        />
      </fieldset>

      <fieldset className="builder-section">
        <legend>Limits</legend>

        <label className="filter">
          <span>Open tickets of this kind per member</span>
          <input
            type="number"
            min={1}
            max={100}
            placeholder="The module’s limit"
            value={type.maxOpenPerUser ?? ''}
            onChange={(e) =>
              onChange({
                maxOpenPerUser: e.target.value === '' ? undefined : e.target.valueAsNumber,
              })
            }
          />
        </label>

        <DurationInput
          label="Wait between opening these"
          placeholder="e.g. 5m — leave empty for the module’s wait"
          value={type.cooldown}
          onChange={(cooldown) => onChange({ cooldown })}
        />
      </fieldset>
    </div>
  );
}

export function TicketTypesEditor({
  types: stored,
  channels,
  roles,
  tier,
  onChange,
}: TicketTypesEditorProps): ReactElement {
  const ceiling = listCeiling(tier, 'ticketTypes');
  const types = stored.map(complete);
  const parsed = ticketTypesSchema.safeParse(types);

  const failed = new Set(
    parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.path[0]).filter((at) => typeof at === 'number'),
  );

  // Held as an index rather than an id, because the id is edited in this very pane and a selection
  // keyed on it would jump to another type on the first keystroke.
  const [selected, setSelected] = useState(0);
  const open = types[selected];

  return (
    <div className="ladder panel-wide" data-path="types">
      <p className="field-description">
        A ticket type is one kind of request — support, reports, appeals — with its own staff,
        intake form, timers and transcript. A panel offers the types you attach to it, so at least
        one has to exist before a panel can do anything.
      </p>

      <div className="pane">
        <div className="pane-list">
          <ul className="pane-items">
            {types.map((type, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the id is edited in place, so it cannot key its own row
                key={`type-${index}`}
              >
                <button
                  type="button"
                  className="pane-item"
                  aria-current={index === selected ? 'true' : undefined}
                  onClick={() => setSelected(index)}
                >
                  <span className="pane-item-name">{type.name || 'Unnamed'}</span>
                  <span className="pane-item-meta">{summarise(type, failed.has(index))}</span>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="pane-add"
            disabled={types.length >= ceiling}
            onClick={() => {
              onChange([...types, blankType(types.length)]);
              setSelected(types.length);
            }}
          >
            <Icon name="plus" />
            {types.length >= ceiling ? ceilingNote(tier, 'ticketTypes') : 'New ticket type'}
          </button>
        </div>

        {open ? (
          <TypeDetail
            type={open}
            channels={channels}
            roles={roles}
            onChange={(patch) =>
              onChange(types.map((type, i) => (i === selected ? { ...type, ...patch } : type)))
            }
            onRemove={() => {
              onChange(types.filter((_, i) => i !== selected));
              setSelected(selected > 0 ? selected - 1 : 0);
            }}
          />
        ) : (
          <div className="pane-edit">
            <p className="field-empty">
              No ticket types. Nothing can be opened until there is one, whatever the panels say.
            </p>
          </div>
        )}
      </div>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {describeIssuePath(issue.path)}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
