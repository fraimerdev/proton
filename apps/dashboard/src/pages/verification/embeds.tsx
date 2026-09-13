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
  embedsLength,
  isEmptyEmbed,
} from '@proton/core';
import type { VerificationConfig } from '@proton/module-verification/config';
import type { ReactElement } from 'react';
import { ColourPicker } from '../../components/discord/inputs.tsx';
import type { ModuleForm } from '../../components/module/form.ts';
import { LimitCounter } from '../../components/ui/collection.tsx';
import {
  Button,
  Checkbox,
  cx,
  IconButton,
  Select,
  TextArea,
  TextInput,
} from '../../components/ui/controls.tsx';
import { DetailField, ExpandableRow, Rows, Section } from '../../components/ui/layout.tsx';

// The grey Discord already draws beside an embed with no colour, so adding one changes nothing
// until a colour is actually picked.
const NO_COLOUR = 0x4e5058;

const LINK_INVALID = 'must be a complete http:// or https:// link';

const EMPTY_EMBED =
  'this embed has nothing in it. An embed needs at least a title, a description, one field, a ' +
  'footer, an author or an image before Discord will accept it.';

function linkError(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return /^https?:\/\//i.test(value) && URL.canParse(value) ? undefined : LINK_INVALID;
}

function overflowError(total: number): string | undefined {
  if (total <= EMBED_TOTAL_MAX) return undefined;

  return (
    `the embeds on this message come to ${total} characters and Discord allows ${EMBED_TOTAL_MAX} ` +
    `across every embed's title, description, field names, field text, footer and author ` +
    `together. Remove ${total - EMBED_TOTAL_MAX} characters.`
  );
}

function duplicateLinkError(embeds: readonly Embed[], index: number): string | undefined {
  const url = embeds[index]?.url;
  if (url === undefined) return undefined;

  const first = embeds.findIndex((embed) => embed.url === url);
  if (first === index || first < 0) return undefined;

  return (
    `embed ${index + 1} carries the same link as embed ${first + 1}. Discord shows only the first ` +
    `embed of any one link, so this one would never appear.`
  );
}

function summarise(embed: Embed, index: number): string {
  return embed.title?.trim() || embed.author?.name.trim() || `Embed ${index + 1}`;
}

function fieldError(name: string, text: string): string | undefined {
  if (name.trim() === '') {
    return text.trim() === ''
      ? 'A field needs a name and text, or remove it.'
      : 'A field needs a name, or remove it.';
  }
  return text.trim() === '' ? 'A field needs text, or remove it.' : undefined;
}

function LinkField({
  label,
  aria,
  width,
  value,
  onChange,
}: {
  label: string;
  aria: string;
  width: 'md' | 'lg';
  value: string | undefined;
  onChange: (next: string) => void;
}): ReactElement {
  const error = linkError(value);

  return (
    <DetailField label={label}>
      <TextInput
        width={width}
        aria-label={aria}
        placeholder="https://…"
        maxLength={EMBED_URL_MAX}
        invalid={error !== undefined}
        value={value ?? ''}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error !== undefined ? (
        <p className="field-error verification-detail-error">{error}</p>
      ) : null}
    </DetailField>
  );
}

interface EditorProps {
  form: ModuleForm<VerificationConfig>;
  embeds: readonly Embed[];
  index: number;
}

function EmbedFields({ form, embeds, index }: EditorProps): ReactElement {
  const fields = embeds[index]?.fields ?? [];
  const base = `panel.embeds.${index}.fields`;

  const write = (next: typeof fields): void => form.set(base, next.length === 0 ? undefined : next);

  return (
    <DetailField label={`Fields · ${fields.length} / ${EMBED_FIELDS_MAX}`}>
      <div className="ladder">
        {fields.map((field, at) => {
          const error = fieldError(field.name, field.value);

          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: an embed field's position is its identity
              key={at}
            >
              <div className={cx('rung', error !== undefined && 'invalid')}>
                <span className="rung-index">{at + 1}</span>
                <div className="rung-body">
                  <TextInput
                    width="md"
                    aria-label={`Field ${at + 1} name`}
                    placeholder="Name"
                    maxLength={EMBED_FIELD_NAME_MAX}
                    invalid={field.name.trim() === ''}
                    value={field.name}
                    onChange={(event) =>
                      write(
                        fields.map((current, cursor) =>
                          cursor === at ? { ...current, name: event.currentTarget.value } : current,
                        ),
                      )
                    }
                  />
                  <TextInput
                    width="lg"
                    aria-label={`Field ${at + 1} text`}
                    placeholder="Text"
                    maxLength={EMBED_FIELD_VALUE_MAX}
                    invalid={field.value.trim() === ''}
                    value={field.value}
                    onChange={(event) =>
                      write(
                        fields.map((current, cursor) =>
                          cursor === at
                            ? { ...current, value: event.currentTarget.value }
                            : current,
                        ),
                      )
                    }
                  />
                  <span className="inline inline-6 text-sm text-muted">
                    <Checkbox
                      checked={field.inline === true}
                      label={`Field ${at + 1} side by side`}
                      onChange={(next) =>
                        write(
                          fields.map((current, cursor) =>
                            cursor === at ? { ...current, inline: next } : current,
                          ),
                        )
                      }
                    />
                    Side by side
                  </span>
                </div>
                <span className="rung-aside">
                  <IconButton
                    tone="ghost"
                    size="sm"
                    icon="trash"
                    label={`Remove field ${at + 1}`}
                    onClick={() => write(fields.filter((_, cursor) => cursor !== at))}
                  />
                </span>
              </div>

              {error !== undefined ? (
                <p className="rung-error" role="alert">
                  {error}
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
          onClick={() => write([...fields, { name: '', value: '' }])}
        >
          Add field
        </Button>
      </div>
    </DetailField>
  );
}

function EmbedEditor({ form, embeds, index }: EditorProps): ReactElement {
  const embed = embeds[index] ?? {};
  const at = `panel.embeds.${index}`;

  const put = (key: string, value: string): void =>
    form.set(`${at}.${key}`, value === '' ? undefined : value);

  const timestamp = embed.timestamp;
  const urlError = linkError(embed.url);
  const duplicate = duplicateLinkError(embeds, index);

  return (
    <>
      <DetailField label="Title">
        <TextInput
          width="lg"
          aria-label="Embed title"
          maxLength={EMBED_TITLE_MAX}
          value={embed.title ?? ''}
          onChange={(event) => put('title', event.currentTarget.value)}
        />
      </DetailField>

      <DetailField label="Title link">
        <TextInput
          width="lg"
          aria-label="Embed title link"
          placeholder="https://…"
          maxLength={EMBED_URL_MAX}
          invalid={urlError !== undefined || duplicate !== undefined}
          value={embed.url ?? ''}
          onChange={(event) => put('url', event.currentTarget.value)}
        />
        {urlError !== undefined ? (
          <p className="field-error verification-detail-error">{urlError}</p>
        ) : null}
      </DetailField>

      {duplicate !== undefined ? (
        <p className="field-error verification-detail-wide">{duplicate}</p>
      ) : null}

      <div className="verification-detail-wide">
        <DetailField label="Description">
          <TextArea
            aria-label="Embed description"
            rows={4}
            maxLength={EMBED_DESCRIPTION_MAX}
            value={embed.description ?? ''}
            onChange={(event) => put('description', event.currentTarget.value)}
          />
        </DetailField>
      </div>

      <DetailField label="Colour">
        {embed.color === undefined ? (
          <Button size="sm" onClick={() => form.set(`${at}.color`, NO_COLOUR)}>
            Add colour
          </Button>
        ) : (
          <span className="inline inline-8">
            <ColourPicker
              value={embed.color}
              label="Embed colour"
              onChange={(next) => form.set(`${at}.color`, next)}
            />
            <Button tone="ghost" size="sm" onClick={() => form.set(`${at}.color`, undefined)}>
              Clear
            </Button>
          </span>
        )}
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
          onChange={(value) => put('timestamp', value)}
        />
      </DetailField>

      <LinkField
        label="Image"
        aria="Embed image address"
        width="lg"
        value={embed.imageUrl}
        onChange={(next) => put('imageUrl', next)}
      />

      <LinkField
        label="Thumbnail"
        aria="Embed thumbnail address"
        width="lg"
        value={embed.thumbnailUrl}
        onChange={(next) => put('thumbnailUrl', next)}
      />

      <div className="verification-detail-row">
        {embed.author === undefined ? (
          <Button size="sm" onClick={() => form.set(`${at}.author`, { name: '' })}>
            Add author
          </Button>
        ) : (
          <>
            <DetailField label="Author">
              <TextInput
                width="md"
                aria-label="Author name"
                maxLength={EMBED_AUTHOR_NAME_MAX}
                invalid={embed.author.name.trim() === ''}
                value={embed.author.name}
                onChange={(event) => form.set(`${at}.author.name`, event.currentTarget.value)}
              />
            </DetailField>
            <LinkField
              label="Author link"
              aria="Author link"
              width="md"
              value={embed.author.url}
              onChange={(next) => put('author.url', next)}
            />
            <LinkField
              label="Author icon"
              aria="Author icon address"
              width="md"
              value={embed.author.iconUrl}
              onChange={(next) => put('author.iconUrl', next)}
            />
            <Button tone="ghost" size="sm" onClick={() => form.set(`${at}.author`, undefined)}>
              Remove author
            </Button>
          </>
        )}
      </div>

      {embed.author !== undefined && embed.author.name.trim() === '' ? (
        <p className="field-error verification-detail-wide">
          An author needs a name, or remove it.
        </p>
      ) : null}

      <div className="verification-detail-row">
        {embed.footer === undefined ? (
          <Button size="sm" onClick={() => form.set(`${at}.footer`, { text: '' })}>
            Add footer
          </Button>
        ) : (
          <>
            <DetailField label="Footer">
              <TextInput
                width="lg"
                aria-label="Footer text"
                maxLength={EMBED_FOOTER_TEXT_MAX}
                invalid={embed.footer.text.trim() === ''}
                value={embed.footer.text}
                onChange={(event) => form.set(`${at}.footer.text`, event.currentTarget.value)}
              />
            </DetailField>
            <LinkField
              label="Footer icon"
              aria="Footer icon address"
              width="md"
              value={embed.footer.iconUrl}
              onChange={(next) => put('footer.iconUrl', next)}
            />
            <Button tone="ghost" size="sm" onClick={() => form.set(`${at}.footer`, undefined)}>
              Remove footer
            </Button>
          </>
        )}
      </div>

      {embed.footer !== undefined && embed.footer.text.trim() === '' ? (
        <p className="field-error verification-detail-wide">A footer needs text, or remove it.</p>
      ) : null}

      <div className="verification-detail-wide">
        <EmbedFields form={form} embeds={embeds} index={index} />
      </div>
    </>
  );
}

export function EmbedsSection({ form }: { form: ModuleForm<VerificationConfig> }): ReactElement {
  const embeds = form.value.panel.embeds;
  const total = embedsLength(embeds);
  const overflow = overflowError(total);

  const write = (next: Embed[]): void => form.set('panel.embeds', next);

  return (
    <Section
      label="Embeds"
      note={<LimitCounter used={total} ceiling={EMBED_TOTAL_MAX} label="characters" />}
      actions={
        <span className="inline inline-8">
          {embeds.length >= EMBEDS_PER_MESSAGE_MAX ? (
            <span className="text-xs text-muted">
              Discord allows up to {EMBEDS_PER_MESSAGE_MAX} embeds on a message.
            </span>
          ) : null}
          <Button
            size="sm"
            icon="plus"
            disabled={embeds.length >= EMBEDS_PER_MESSAGE_MAX}
            onClick={() => write([...embeds, {}])}
          >
            Add embed
          </Button>
        </span>
      }
    >
      {embeds.length > 0 ? (
        <Rows>
          {embeds.map((embed, index) => (
            <ExpandableRow
              // biome-ignore lint/suspicious/noArrayIndexKey: an embed's position is its identity
              key={index}
              title={summarise(embed, index)}
              description={isEmptyEmbed(embed) ? EMPTY_EMBED : undefined}
              defaultOpen={isEmptyEmbed(embed)}
              control={
                <IconButton
                  tone="ghost"
                  size="sm"
                  icon="trash"
                  label={`Remove embed ${index + 1}`}
                  onClick={() => write(embeds.filter((_, cursor) => cursor !== index))}
                />
              }
              detail={() => <EmbedEditor form={form} embeds={embeds} index={index} />}
            />
          ))}
        </Rows>
      ) : null}

      {overflow !== undefined ? (
        <p className="row-error" role="alert">
          {overflow}
        </p>
      ) : null}
    </Section>
  );
}
