import {
  EMBED_AUTHOR_NAME_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_TEXT_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
  EMBED_URL_MAX,
  EMBEDS_PER_MESSAGE_MAX,
  type Embed,
  type EmbedField,
  embedsLength,
  isEmptyEmbed,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import type { FieldErrors } from '../module/form.ts';
import type { PlaceholderFieldProps } from '../placeholders/use-placeholder-autocomplete.ts';
import { LimitCounter, useRecent } from '../ui/collection.tsx';
import { Button, Checkbox, cx, IconButton, Select, TextArea, TextInput } from '../ui/controls.tsx';
import { DetailField, ExpandableRow, Rows, Section } from '../ui/layout.tsx';
import { ColourPicker } from './inputs.tsx';

export interface ConfigErrors {
  at: (path: string) => string | undefined;
  under: (path: string) => string | undefined;
}

export function configErrors(form: {
  errors: FieldErrors;
  errorAt: (path: string) => string | undefined;
}): ConfigErrors {
  return {
    at: form.errorAt,
    under: (path) => {
      const exact = form.errorAt(path);
      if (exact !== undefined) return exact;

      for (const [key, message] of form.errors) {
        if (key.startsWith(`${path}.`)) return message;
      }
      return undefined;
    },
  };
}

export interface PlaceholderField {
  path: string;
  value: string;
  onChange: (next: string) => void;
}

export interface PlaceholderKit {
  field?: PlaceholderFieldProps | undefined;
  suggestions?: ReactNode;
  describedBy?: string | undefined;
  diagnostics?: ReactNode;
  diagnosticMessages?: readonly string[] | undefined;
}

export type PlaceholderSlot = (
  field: PlaceholderField,
  render: (kit: PlaceholderKit) => ReactElement,
) => ReactElement | null;

const LINK_MISSING = 'Enter a complete http:// or https:// link.';
const AUTHOR_EMPTY = 'An author needs a name, or remove it.';
const FOOTER_EMPTY = 'A footer needs text, or remove it.';

// Discord's own grey beside an embed with no colour, so adding one changes nothing until one is picked.
const NO_COLOUR = 0x4e5058;

const SUMMARY_MAX = 90;

export function blank(value: string): string | undefined {
  return value === '' ? undefined : value;
}

export function sentence(message: string): string {
  const text = message.trim();
  if (text === '') return text;

  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

export function linkIssue(value: string, reported: string | undefined): string | undefined {
  if (reported === undefined) return undefined;
  return value.trim() === '' ? LINK_MISSING : sentence(reported);
}

export function textIssue(
  value: string,
  reported: string | undefined,
  empty: string | undefined,
): string | undefined {
  if (reported === undefined) return undefined;
  return empty !== undefined && value.trim() === '' ? empty : sentence(reported);
}

export function embedFieldIssue(
  field: EmbedField,
  errors: ConfigErrors,
  path: string,
): string | undefined {
  if (errors.at(`${path}.name`) === undefined && errors.at(`${path}.value`) === undefined) {
    return undefined;
  }

  const nameless = field.name.trim() === '';
  const textless = field.value.trim() === '';

  if (nameless && textless) return 'A field needs a name and text, or remove it.';
  if (nameless) return 'A field needs a name, or remove it.';
  return textless ? 'A field needs text, or remove it.' : undefined;
}

function embedLinks(embed: Embed): ReadonlyArray<readonly [string, string | undefined]> {
  return [
    ['url', embed.url],
    ['imageUrl', embed.imageUrl],
    ['thumbnailUrl', embed.thumbnailUrl],
    ['author.url', embed.author?.url],
    ['author.iconUrl', embed.author?.iconUrl],
    ['footer.iconUrl', embed.footer?.iconUrl],
  ];
}

export function embedIssue(embed: Embed, errors: ConfigErrors, path: string): string | undefined {
  const exact = errors.at(path);
  if (exact !== undefined) return sentence(exact);

  const nested = errors.under(path);
  if (nested === undefined) return undefined;

  for (const [key, value] of embedLinks(embed)) {
    const issue = linkIssue(value ?? '', errors.at(`${path}.${key}`));
    if (issue !== undefined) return issue;
  }

  const named =
    textIssue(embed.author?.name ?? '', errors.at(`${path}.author.name`), AUTHOR_EMPTY) ??
    textIssue(embed.footer?.text ?? '', errors.at(`${path}.footer.text`), FOOTER_EMPTY);
  if (named !== undefined) return named;

  for (const [index, field] of (embed.fields ?? []).entries()) {
    const issue = embedFieldIssue(field, errors, `${path}.fields.${index}`);
    if (issue !== undefined) return issue;
  }

  return sentence(nested);
}

export function summariseEmbed(embed: Embed): string | undefined {
  for (const text of [embed.title, embed.description, embed.author?.name]) {
    const line = text?.trim().split('\n')[0]?.trim();
    if (line === undefined || line === '') continue;

    return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line;
  }

  return undefined;
}

interface MessageFieldProps {
  placeholders: PlaceholderSlot | undefined;
  path: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error: string | undefined;
  link?: boolean | undefined;
  empty?: string | null | undefined;
  rows?: number | undefined;
  width?: 'md' | 'lg' | undefined;
  layout?: 'grow' | 'wide' | undefined;
  placeholder?: string | undefined;
  maxLength?: number | undefined;
  note?: ReactNode;
}

export function MessageField({
  placeholders,
  path,
  label,
  value,
  onChange,
  error,
  link = false,
  empty,
  rows,
  width,
  layout,
  placeholder,
  maxLength,
  note,
}: MessageFieldProps): ReactElement {
  const render = (kit: PlaceholderKit): ReactElement => {
    const explained = error !== undefined && kit.diagnosticMessages?.includes(error) === true;

    const issue =
      error === undefined || explained
        ? undefined
        : link
          ? linkIssue(value, error)
          : empty === null && value.trim() === ''
            ? undefined
            : textIssue(value, error, empty ?? undefined);

    const common = {
      'aria-label': label,
      'aria-describedby': kit.describedBy,
      invalid: error !== undefined,
      placeholder,
      maxLength,
      value,
    };

    const wiring = kit.field ?? {};

    const control =
      rows === undefined ? (
        <TextInput
          {...wiring}
          width={width}
          {...common}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <TextArea
          {...wiring}
          rows={rows}
          {...common}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );

    const notes = issue !== undefined || kit.diagnostics !== undefined || note !== undefined;

    return (
      <div className={cx('message-field', layout)}>
        {control}
        {kit.suggestions}

        {notes ? (
          <div className="message-field-notes">
            {issue !== undefined ? (
              <p className="field-error" role="alert">
                {issue}
              </p>
            ) : null}
            {kit.diagnostics}
            {note !== undefined ? <span className="field-hint">{note}</span> : null}
          </div>
        ) : null}
      </div>
    );
  };

  return placeholders?.({ path, value, onChange }, render) ?? render({});
}

export function OptionalColour({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: number | undefined;
  fallback: number;
  onChange: (next: number | undefined) => void;
}): ReactElement {
  if (value === undefined) {
    return (
      <Button size="sm" onClick={() => onChange(fallback)}>
        Add colour
      </Button>
    );
  }

  return (
    <span className="inline inline-8">
      <ColourPicker label={label} value={value} onChange={onChange} />
      <Button tone="ghost" size="sm" onClick={() => onChange(undefined)}>
        Clear
      </Button>
    </span>
  );
}

interface EmbedFieldsProps {
  embed: Embed;
  path: string;
  errors: ConfigErrors;
  placeholders: PlaceholderSlot | undefined;
  onChange: (next: Embed) => void;
}

function EmbedFields({
  embed,
  path,
  errors,
  placeholders,
  onChange,
}: EmbedFieldsProps): ReactElement {
  const recent = useRecent();

  const fields = embed.fields ?? [];
  const { author, footer, timestamp } = embed;

  const setFields = (next: EmbedField[]): void =>
    onChange({ ...embed, fields: next.length === 0 ? undefined : next });

  const setField = (index: number, next: EmbedField): void =>
    setFields(fields.map((current, at) => (at === index ? next : current)));

  return (
    <>
      <DetailField label="Title">
        <MessageField
          placeholders={placeholders}
          path={`${path}.title`}
          label="Embed title"
          width="lg"
          maxLength={EMBED_TITLE_MAX}
          value={embed.title ?? ''}
          error={errors.at(`${path}.title`)}
          onChange={(next) => onChange({ ...embed, title: blank(next) })}
        />
      </DetailField>

      <DetailField label="Title link">
        <MessageField
          placeholders={placeholders}
          path={`${path}.url`}
          label="Embed title link"
          link
          width="lg"
          placeholder="https://…"
          maxLength={EMBED_URL_MAX}
          value={embed.url ?? ''}
          error={errors.at(`${path}.url`)}
          onChange={(next) => onChange({ ...embed, url: blank(next) })}
        />
      </DetailField>

      <div className="message-detail-wide">
        <DetailField label="Description">
          <MessageField
            placeholders={placeholders}
            path={`${path}.description`}
            label="Embed description"
            rows={4}
            maxLength={EMBED_DESCRIPTION_MAX}
            value={embed.description ?? ''}
            error={errors.at(`${path}.description`)}
            note={`${(embed.description ?? '').length} / ${EMBED_DESCRIPTION_MAX} · Supports Discord markdown`}
            onChange={(next) => onChange({ ...embed, description: blank(next) })}
          />
        </DetailField>
      </div>

      <DetailField label="Colour">
        <OptionalColour
          label="Embed colour"
          value={embed.color}
          fallback={NO_COLOUR}
          onChange={(next) => onChange({ ...embed, color: next })}
        />
      </DetailField>

      <DetailField label="Timestamp">
        <Select
          aria-label="Embed timestamp"
          width="md"
          value={timestamp ?? ''}
          options={[
            { value: '', label: 'None' },
            { value: 'now', label: 'When posted' },
            ...(timestamp !== undefined && timestamp !== 'now'
              ? [{ value: timestamp, label: new Date(timestamp).toLocaleString() }]
              : []),
          ]}
          onChange={(next) => onChange({ ...embed, timestamp: blank(next) })}
        />
      </DetailField>

      <DetailField label="Image">
        <MessageField
          placeholders={placeholders}
          path={`${path}.imageUrl`}
          label="Embed image address"
          link
          width="lg"
          placeholder="https://…"
          maxLength={EMBED_URL_MAX}
          value={embed.imageUrl ?? ''}
          error={errors.at(`${path}.imageUrl`)}
          onChange={(next) => onChange({ ...embed, imageUrl: blank(next) })}
        />
      </DetailField>

      <DetailField label="Thumbnail">
        <MessageField
          placeholders={placeholders}
          path={`${path}.thumbnailUrl`}
          label="Embed thumbnail address"
          link
          width="lg"
          placeholder="https://…"
          maxLength={EMBED_URL_MAX}
          value={embed.thumbnailUrl ?? ''}
          error={errors.at(`${path}.thumbnailUrl`)}
          onChange={(next) => onChange({ ...embed, thumbnailUrl: blank(next) })}
        />
      </DetailField>

      <div className="message-detail-group">
        {author === undefined ? (
          <Button size="sm" onClick={() => onChange({ ...embed, author: { name: '' } })}>
            Add author
          </Button>
        ) : (
          <>
            <DetailField label="Author">
              <MessageField
                placeholders={placeholders}
                path={`${path}.author.name`}
                label="Author name"
                width="md"
                maxLength={EMBED_AUTHOR_NAME_MAX}
                value={author.name}
                error={errors.at(`${path}.author.name`)}
                empty={AUTHOR_EMPTY}
                onChange={(next) => onChange({ ...embed, author: { ...author, name: next } })}
              />
            </DetailField>
            <DetailField label="Author link">
              <MessageField
                placeholders={placeholders}
                path={`${path}.author.url`}
                label="Author link"
                link
                width="md"
                placeholder="https://…"
                maxLength={EMBED_URL_MAX}
                value={author.url ?? ''}
                error={errors.at(`${path}.author.url`)}
                onChange={(next) => onChange({ ...embed, author: { ...author, url: blank(next) } })}
              />
            </DetailField>
            <DetailField label="Author icon">
              <MessageField
                placeholders={placeholders}
                path={`${path}.author.iconUrl`}
                label="Author icon address"
                link
                width="md"
                placeholder="https://…"
                maxLength={EMBED_URL_MAX}
                value={author.iconUrl ?? ''}
                error={errors.at(`${path}.author.iconUrl`)}
                onChange={(next) =>
                  onChange({ ...embed, author: { ...author, iconUrl: blank(next) } })
                }
              />
            </DetailField>
            <Button
              tone="ghost"
              size="sm"
              onClick={() => onChange({ ...embed, author: undefined })}
            >
              Remove author
            </Button>
          </>
        )}
      </div>

      <div className="message-detail-group">
        {footer === undefined ? (
          <Button size="sm" onClick={() => onChange({ ...embed, footer: { text: '' } })}>
            Add footer
          </Button>
        ) : (
          <>
            <DetailField label="Footer">
              <MessageField
                placeholders={placeholders}
                path={`${path}.footer.text`}
                label="Footer text"
                width="lg"
                maxLength={EMBED_FOOTER_TEXT_MAX}
                value={footer.text}
                error={errors.at(`${path}.footer.text`)}
                empty={FOOTER_EMPTY}
                onChange={(next) => onChange({ ...embed, footer: { ...footer, text: next } })}
              />
            </DetailField>
            <DetailField label="Footer icon">
              <MessageField
                placeholders={placeholders}
                path={`${path}.footer.iconUrl`}
                label="Footer icon address"
                link
                width="md"
                placeholder="https://…"
                maxLength={EMBED_URL_MAX}
                value={footer.iconUrl ?? ''}
                error={errors.at(`${path}.footer.iconUrl`)}
                onChange={(next) =>
                  onChange({ ...embed, footer: { ...footer, iconUrl: blank(next) } })
                }
              />
            </DetailField>
            <Button
              tone="ghost"
              size="sm"
              onClick={() => onChange({ ...embed, footer: undefined })}
            >
              Remove footer
            </Button>
          </>
        )}
      </div>

      <div className="message-detail-wide">
        <DetailField label={`Fields · ${fields.length} / ${EMBED_FIELDS_MAX}`}>
          <div className="ladder">
            {fields.map((field, index) => {
              const at = `${path}.fields.${index}`;
              const issue = embedFieldIssue(field, errors, at);

              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: an embed field's position is its identity
                <div key={index} className={recent.enter(index, 'part')}>
                  <div className={cx('rung', issue !== undefined && 'invalid')}>
                    <span className="rung-index">{index + 1}</span>
                    <div className="rung-body">
                      <MessageField
                        placeholders={placeholders}
                        path={`${at}.name`}
                        label={`Field ${index + 1} name`}
                        placeholder="Name"
                        width="md"
                        maxLength={EMBED_FIELD_NAME_MAX}
                        value={field.name}
                        error={errors.at(`${at}.name`)}
                        empty={null}
                        onChange={(next) => setField(index, { ...field, name: next })}
                      />
                      <span className="inline inline-6 text-sm text-muted">
                        <Checkbox
                          checked={field.inline === true}
                          label={`Field ${index + 1} side by side`}
                          onChange={(next) => setField(index, { ...field, inline: next })}
                        />
                        Side by side
                      </span>
                      <MessageField
                        placeholders={placeholders}
                        path={`${at}.value`}
                        label={`Field ${index + 1} text`}
                        placeholder="Text"
                        rows={2}
                        layout="wide"
                        maxLength={EMBED_FIELD_VALUE_MAX}
                        value={field.value}
                        error={errors.at(`${at}.value`)}
                        empty={null}
                        onChange={(next) => setField(index, { ...field, value: next })}
                      />
                    </div>
                    <span className="rung-aside">
                      <IconButton
                        tone="ghost"
                        size="sm"
                        icon="trash"
                        label={`Remove field ${index + 1}`}
                        onClick={() => setFields(fields.filter((_, cursor) => cursor !== index))}
                      />
                    </span>
                  </div>

                  {issue !== undefined ? (
                    <p className="rung-error" role="alert">
                      {issue}
                    </p>
                  ) : null}
                </div>
              );
            })}

            <Button
              className="ladder-add"
              size="sm"
              icon="plus"
              disabled={fields.length >= EMBED_FIELDS_MAX}
              onClick={() => {
                recent.mark(fields.length);
                setFields([...fields, { name: '', value: '' }]);
              }}
            >
              Add field
            </Button>
          </div>
        </DetailField>
      </div>
    </>
  );
}

export interface EmbedEditorProps {
  value: readonly Embed[];
  onChange: (next: Embed[]) => void;
  errors: ConfigErrors;
  prefix: string;
  placeholders?: PlaceholderSlot | undefined;
}

export function EmbedEditor({
  value,
  onChange,
  errors,
  prefix,
  placeholders,
}: EmbedEditorProps): ReactElement {
  const recent = useRecent();

  const total = embedsLength(value);
  const full = value.length >= EMBEDS_PER_MESSAGE_MAX;
  const totalError = errors.at(prefix);

  return (
    <Section
      label="Embeds"
      note={
        value.length === 0 ? undefined : (
          <LimitCounter used={total} ceiling={EMBED_TOTAL_MAX} label="characters" />
        )
      }
      actions={
        <span className="inline inline-8">
          {full ? (
            <span className="text-xs text-muted">
              Discord allows up to {EMBEDS_PER_MESSAGE_MAX} embeds on a message.
            </span>
          ) : null}
          <Button
            size="sm"
            icon="plus"
            disabled={full}
            onClick={() => {
              recent.mark(value.length);
              onChange([...value, {}]);
            }}
          >
            Add embed
          </Button>
        </span>
      }
    >
      {totalError !== undefined ? (
        <p className="row-error" role="alert">
          {sentence(totalError)}
        </p>
      ) : null}

      {value.length === 0 ? (
        <p className="section-intro">No embeds.</p>
      ) : (
        <Rows>
          {value.map((embed, index) => {
            const path = `${prefix}.${index}`;
            const issue = embedIssue(embed, errors, path);

            return (
              <ExpandableRow
                // biome-ignore lint/suspicious/noArrayIndexKey: an embed's position is its identity
                key={index}
                className={recent.enter(index, 'part')}
                title={`Embed ${index + 1}`}
                description={
                  issue !== undefined ? (
                    <span className="text-danger">{issue}</span>
                  ) : (
                    summariseEmbed(embed)
                  )
                }
                defaultOpen={value.length === 1 || isEmptyEmbed(embed)}
                control={
                  <IconButton
                    icon="trash"
                    tone="ghost"
                    size="sm"
                    label={`Remove embed ${index + 1}`}
                    onClick={() => onChange(value.filter((_, at) => at !== index))}
                  />
                }
                detail={() => (
                  <EmbedFields
                    embed={embed}
                    path={path}
                    errors={errors}
                    placeholders={placeholders}
                    onChange={(next) =>
                      onChange(value.map((current, at) => (at === index ? next : current)))
                    }
                  />
                )}
              />
            );
          })}
        </Rows>
      )}
    </Section>
  );
}
