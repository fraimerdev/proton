import type { Embed, EmbedField } from '@proton/core';
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
  embedsLength,
} from '@proton/core';
import type { ReactElement } from 'react';
import { ColourPicker, DEFAULT_EMBED_COLOUR } from '../../components/discord/inputs.tsx';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  cx,
  IconButton,
  Switch,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { DetailField, ExpandableRow, Rows, Section } from '../../components/ui/layout.tsx';
import type { ConfigErrors } from './errors.ts';

function summarise(embed: Embed): string | undefined {
  const line = embed.title ?? embed.description ?? embed.author?.name;
  if (line === undefined || line.trim() === '') return undefined;

  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function EmbedFields({
  embed,
  onChange,
  errors,
  prefix,
}: {
  embed: Embed;
  onChange: (next: Embed) => void;
  errors: ConfigErrors;
  prefix: string;
}): ReactElement {
  const set = <K extends keyof Embed>(key: K, value: Embed[K]): void =>
    onChange({ ...embed, [key]: value });

  const recent = useRecent();

  const fields: readonly EmbedField[] = embed.fields ?? [];
  const setFields = (next: EmbedField[]): void =>
    onChange({ ...embed, fields: next.length === 0 ? undefined : next });

  const urlError = errors.at(`${prefix}.url`);
  const author = embed.author;
  const footer = embed.footer;

  return (
    <>
      <DetailField label="Title">
        <TextInput
          className="control-w-lg"
          aria-label="Embed title"
          maxLength={EMBED_TITLE_MAX}
          value={embed.title ?? ''}
          onChange={(event) => set('title', event.currentTarget.value || undefined)}
        />
      </DetailField>

      <DetailField label="Colour">
        <ColourPicker
          label="Embed colour"
          value={embed.color ?? DEFAULT_EMBED_COLOUR}
          onChange={(next) => set('color', next)}
        />
      </DetailField>

      <DetailField label="Timestamp">
        <Switch
          label="Show timestamp"
          checked={embed.timestamp !== undefined}
          onChange={(next) => set('timestamp', next ? 'now' : undefined)}
        />
      </DetailField>

      <div className="welcome-detail-wide stack stack-6">
        <span className="row-detail-label">Title link</span>
        <TextInput
          aria-label="Embed title link"
          placeholder="https://…"
          maxLength={EMBED_URL_MAX}
          invalid={urlError !== undefined}
          value={embed.url ?? ''}
          onChange={(event) => set('url', event.currentTarget.value || undefined)}
        />
        {urlError !== undefined ? <p className="row-error">{urlError}</p> : null}
      </div>

      <div className="welcome-detail-wide stack stack-6">
        <span className="row-detail-label">Description</span>
        <TextArea
          aria-label="Embed description"
          rows={4}
          maxLength={EMBED_DESCRIPTION_MAX}
          value={embed.description ?? ''}
          onChange={(event) => set('description', event.currentTarget.value || undefined)}
        />
        <span className="text-xs text-muted">
          {(embed.description ?? '').length} / {EMBED_DESCRIPTION_MAX} · Supports Discord markdown
        </span>
      </div>

      <DetailField label="Author">
        <TextInput
          className="control-w-md"
          aria-label="Embed author name"
          maxLength={EMBED_AUTHOR_NAME_MAX}
          value={author?.name ?? ''}
          onChange={(event) =>
            set(
              'author',
              event.currentTarget.value
                ? { ...author, name: event.currentTarget.value }
                : undefined,
            )
          }
        />
      </DetailField>

      {author !== undefined ? (
        <DetailField label="Author icon">
          <TextInput
            className="control-w-md"
            aria-label="Embed author icon"
            placeholder="https://…"
            value={author.iconUrl ?? ''}
            onChange={(event) =>
              set('author', { ...author, iconUrl: event.currentTarget.value || undefined })
            }
          />
        </DetailField>
      ) : null}

      <DetailField label="Footer">
        <TextInput
          className="control-w-md"
          aria-label="Embed footer"
          maxLength={EMBED_FOOTER_TEXT_MAX}
          value={footer?.text ?? ''}
          onChange={(event) =>
            set(
              'footer',
              event.currentTarget.value
                ? { ...footer, text: event.currentTarget.value }
                : undefined,
            )
          }
        />
      </DetailField>

      {footer !== undefined ? (
        <DetailField label="Footer icon">
          <TextInput
            className="control-w-md"
            aria-label="Embed footer icon"
            placeholder="https://…"
            value={footer.iconUrl ?? ''}
            onChange={(event) =>
              set('footer', { ...footer, iconUrl: event.currentTarget.value || undefined })
            }
          />
        </DetailField>
      ) : null}

      <DetailField label="Image">
        <TextInput
          className="control-w-md"
          aria-label="Embed image address"
          placeholder="https://…"
          value={embed.imageUrl ?? ''}
          onChange={(event) => set('imageUrl', event.currentTarget.value || undefined)}
        />
      </DetailField>

      <DetailField label="Thumbnail">
        <TextInput
          className="control-w-md"
          aria-label="Embed thumbnail address"
          placeholder="https://…"
          value={embed.thumbnailUrl ?? ''}
          onChange={(event) => set('thumbnailUrl', event.currentTarget.value || undefined)}
        />
      </DetailField>

      <div className="welcome-detail-wide stack stack-8">
        <span className="row-detail-label">
          Fields · {fields.length} / {EMBED_FIELDS_MAX}
        </span>

        {fields.map((field, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an embed field's position is its identity
          <div className={cx('stack stack-6', recent.enter(index, 'part'))} key={index}>
            <div className="inline inline-8">
              <TextInput
                className="control-w-md"
                aria-label={`Field ${index + 1} name`}
                maxLength={EMBED_FIELD_NAME_MAX}
                value={field.name}
                onChange={(event) =>
                  setFields(
                    fields.map((current, at) =>
                      at === index ? { ...current, name: event.currentTarget.value } : current,
                    ),
                  )
                }
              />
              <span className="push-right inline inline-8">
                <span className="text-xs text-muted">Side by side</span>
                <Switch
                  label={`Field ${index + 1} side by side`}
                  checked={field.inline === true}
                  onChange={(next) =>
                    setFields(
                      fields.map((current, at) =>
                        at === index ? { ...current, inline: next } : current,
                      ),
                    )
                  }
                />
                <IconButton
                  icon="trash"
                  tone="ghost"
                  size="sm"
                  label={`Remove field ${index + 1}`}
                  onClick={() => setFields(fields.filter((_, at) => at !== index))}
                />
              </span>
            </div>
            <TextArea
              aria-label={`Field ${index + 1} text`}
              rows={2}
              maxLength={EMBED_FIELD_VALUE_MAX}
              value={field.value}
              onChange={(event) =>
                setFields(
                  fields.map((current, at) =>
                    at === index ? { ...current, value: event.currentTarget.value } : current,
                  ),
                )
              }
            />
          </div>
        ))}

        <Button
          size="sm"
          icon="plus"
          className="ladder-add"
          disabled={fields.length >= EMBED_FIELDS_MAX}
          onClick={() => {
            recent.mark(fields.length);
            setFields([...fields, { name: 'Field', value: 'Value' }]);
          }}
        >
          Add field
        </Button>
      </div>
    </>
  );
}

export function EmbedsSection({
  value,
  onChange,
  errors,
  prefix,
}: {
  value: readonly Embed[];
  onChange: (next: Embed[]) => void;
  errors: ConfigErrors;
  prefix: string;
}): ReactElement {
  const totalError = errors.at(prefix);
  const recent = useRecent();

  return (
    <Section
      label="Embeds"
      note={
        value.length === 0
          ? undefined
          : `${embedsLength(value)} / ${EMBED_TOTAL_MAX} characters · ${value.length} / ${EMBEDS_PER_MESSAGE_MAX}`
      }
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={value.length >= EMBEDS_PER_MESSAGE_MAX}
          onClick={() => {
            recent.mark(value.length);
            onChange([...value, { description: '', color: DEFAULT_EMBED_COLOUR }]);
          }}
        >
          Add embed
        </Button>
      }
    >
      {totalError !== undefined ? <p className="row-error">{totalError}</p> : null}

      {value.length === 0 ? (
        <p className="section-intro">No embeds.</p>
      ) : (
        <Rows>
          {value.map((embed, index) => {
            const error = errors.under(`${prefix}.${index}`);

            return (
              <ExpandableRow
                // biome-ignore lint/suspicious/noArrayIndexKey: an embed's position is its identity
                key={index}
                className={recent.enter(index, 'part')}
                title={`Embed ${index + 1}`}
                description={
                  error !== undefined ? (
                    <span className="text-danger">{error}</span>
                  ) : (
                    summarise(embed)
                  )
                }
                defaultOpen={value.length === 1}
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
                    prefix={`${prefix}.${index}`}
                    errors={errors}
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
