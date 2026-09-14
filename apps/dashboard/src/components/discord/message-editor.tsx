import type { ActionRow, Embed, EmbedField, MessageButton, ProtonMessage } from '@proton/core';
import {
  BUTTON_LABEL_MAX,
  BUTTON_STYLES,
  BUTTON_URL_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_TEXT_MAX,
  EMBED_TITLE_MAX,
  EMBED_URL_MAX,
  MESSAGE_CONTENT_MAX,
  SELECT_OPTION_LABEL_MAX,
} from '@proton/core';
import type { PlaceholderSurface, SurfaceDiagnostic } from '@proton/core/placeholders';
import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { PlaceholderSuggestions } from '../placeholders/placeholder-suggestions.tsx';
import { TemplateDiagnostics, visibleDiagnostics } from '../placeholders/template-diagnostics.tsx';
import { usePlaceholderAutocomplete } from '../placeholders/use-placeholder-autocomplete.ts';
import { useRecent } from '../ui/collection.tsx';
import { Button, cx, IconButton, Select, Switch } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';
import { Rows, Section, SettingRow } from '../ui/layout.tsx';
import {
  blank,
  MessageField,
  type PlaceholderField,
  type PlaceholderKit,
  type PlaceholderSlot,
} from './embed-editor.tsx';
import { EmojiPicker } from './emoji-picker.tsx';
import { ColourPicker, DEFAULT_EMBED_COLOUR } from './inputs.tsx';

export type EditableMessage = Pick<ProtonMessage, 'content' | 'embeds' | 'components' | 'mentions'>;

export type TemplateDiagnosticsAt = (path: string) => readonly SurfaceDiagnostic[];

type ErrorAt = (path: string) => string | undefined;

interface MessageEditorProps {
  guildId: string;
  value: EditableMessage;
  onChange: (next: EditableMessage) => void;
  allow?:
    | {
        embed?: boolean | undefined;
        components?: boolean | undefined;
        mentions?: boolean | undefined;
      }
    | undefined;
  placeholders?: PlaceholderSlot | undefined;
  contentLabel?: string | undefined;
  contentDescription?: ReactNode;
  errorAt?: ErrorAt | undefined;
  pathPrefix?: string | undefined;
}

const BUTTON_STYLE_LABELS: Record<string, string> = {
  primary: 'Blurple',
  secondary: 'Grey',
  success: 'Green',
  danger: 'Red',
  link: 'Link',
};

const FIELD_NAMELESS = 'A field needs a name, or remove it.';
const FIELD_TEXTLESS = 'A field needs text, or remove it.';

function countLabel(used: number, max: number): string {
  return `${used} / ${max}`;
}

const NO_DIAGNOSTICS: readonly SurfaceDiagnostic[] = [];

function PlaceholderAutocompleteField({
  surface,
  field,
  diagnostics = NO_DIAGNOSTICS,
  render,
}: {
  surface: PlaceholderSurface<unknown>;
  field: PlaceholderField;
  diagnostics: readonly SurfaceDiagnostic[] | undefined;
  render: (kit: PlaceholderKit) => ReactElement;
}): ReactElement {
  const id = useId();
  const autocomplete = usePlaceholderAutocomplete({
    surface,
    path: field.path,
    onChange: field.onChange,
  });
  const listed = visibleDiagnostics(diagnostics).shown.length > 0;

  return render({
    field: autocomplete.field,
    suggestions: <PlaceholderSuggestions autocomplete={autocomplete} />,
    describedBy: listed ? id : undefined,
    diagnostics: listed ? <TemplateDiagnostics id={id} diagnostics={diagnostics} /> : undefined,
    diagnosticMessages: diagnostics.map(({ message }) => message),
  });
}

export function placeholderSlot(
  surface: PlaceholderSurface<unknown>,
  diagnosticsAt?: TemplateDiagnosticsAt | undefined,
): PlaceholderSlot {
  return (field, render) =>
    surface.fieldAt(field.path) === undefined ? null : (
      <PlaceholderAutocompleteField
        key={field.path}
        surface={surface}
        field={field}
        diagnostics={diagnosticsAt?.(field.path)}
        render={render}
      />
    );
}

function SingleEmbedEditor({
  embed,
  path,
  onChange,
  onRemove,
  errorAt,
  placeholders,
  className,
}: {
  embed: Embed;
  path: string;
  onChange: (next: Embed) => void;
  onRemove: () => void;
  errorAt: ErrorAt;
  placeholders: PlaceholderSlot | undefined;
  className?: string | undefined;
}): ReactElement {
  const recent = useRecent();

  const set = <K extends keyof Embed>(key: K, value: Embed[K]): void =>
    onChange({ ...embed, [key]: value });

  const fields = embed.fields ?? [];

  const setField = (index: number, next: EmbedField): void =>
    set(
      'fields',
      fields.map((current, at) => (at === index ? next : current)),
    );

  return (
    <>
      <Rows className={className}>
        <SettingRow title="Title">
          <MessageField
            placeholders={placeholders}
            path={`${path}.title`}
            label="Embed title"
            width="lg"
            maxLength={EMBED_TITLE_MAX}
            value={embed.title ?? ''}
            error={errorAt(`${path}.title`)}
            onChange={(next) => set('title', blank(next))}
          />
        </SettingRow>

        <SettingRow title="Description" description="Supports Discord markdown." stacked>
          <MessageField
            placeholders={placeholders}
            path={`${path}.description`}
            label="Embed description"
            rows={5}
            layout="wide"
            maxLength={EMBED_DESCRIPTION_MAX}
            value={embed.description ?? ''}
            error={errorAt(`${path}.description`)}
            note={countLabel((embed.description ?? '').length, EMBED_DESCRIPTION_MAX)}
            onChange={(next) => set('description', blank(next))}
          />
        </SettingRow>

        <SettingRow title="Colour" description="The bar down the left edge of the embed.">
          <ColourPicker
            label="Embed colour"
            value={embed.color ?? DEFAULT_EMBED_COLOUR}
            onChange={(next) => set('color', next)}
          />
        </SettingRow>

        <SettingRow title="Footer">
          <MessageField
            placeholders={placeholders}
            path={`${path}.footer.text`}
            label="Embed footer"
            width="lg"
            maxLength={EMBED_FOOTER_TEXT_MAX}
            value={embed.footer?.text ?? ''}
            error={errorAt(`${path}.footer.text`)}
            onChange={(next) =>
              set('footer', next === '' ? undefined : { ...embed.footer, text: next })
            }
          />
        </SettingRow>

        <SettingRow title="Image" description="Shown full width under the text.">
          <MessageField
            placeholders={placeholders}
            path={`${path}.imageUrl`}
            label="Embed image URL"
            link
            width="lg"
            placeholder="https://…"
            maxLength={EMBED_URL_MAX}
            value={embed.imageUrl ?? ''}
            error={errorAt(`${path}.imageUrl`)}
            onChange={(next) => set('imageUrl', blank(next))}
          />
        </SettingRow>

        <SettingRow title="Thumbnail" description="Shown small, top right.">
          <MessageField
            placeholders={placeholders}
            path={`${path}.thumbnailUrl`}
            label="Embed thumbnail URL"
            link
            width="lg"
            placeholder="https://…"
            maxLength={EMBED_URL_MAX}
            value={embed.thumbnailUrl ?? ''}
            error={errorAt(`${path}.thumbnailUrl`)}
            onChange={(next) => set('thumbnailUrl', blank(next))}
          />
        </SettingRow>
      </Rows>

      <Section
        label="Fields"
        className={className}
        note={`${fields.length} / ${EMBED_FIELDS_MAX}`}
        actions={
          <Button
            size="sm"
            icon="plus"
            disabled={fields.length >= EMBED_FIELDS_MAX}
            onClick={() => {
              recent.mark(fields.length);
              set('fields', [...fields, { name: 'Field', value: 'Value', inline: false }]);
            }}
          >
            Add field
          </Button>
        }
      >
        {fields.length === 0 ? null : (
          <Rows>
            {fields.map((field, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: embed fields have no id of their own
              <div className={cx('row stacked', recent.enter(index, 'part'))} key={index}>
                <div className="inline inline-8">
                  <MessageField
                    placeholders={placeholders}
                    path={`${path}.fields.${index}.name`}
                    label={`Field ${index + 1} name`}
                    width="md"
                    maxLength={EMBED_FIELD_NAME_MAX}
                    value={field.name}
                    error={errorAt(`${path}.fields.${index}.name`)}
                    empty={FIELD_NAMELESS}
                    onChange={(next) => setField(index, { ...field, name: next })}
                  />
                  <span className="push-right inline inline-8">
                    <span className="text-xs text-muted">Inline</span>
                    <Switch
                      label={`Field ${index + 1} inline`}
                      checked={field.inline === true}
                      onChange={(next) => setField(index, { ...field, inline: next })}
                    />
                    <IconButton
                      icon="trash"
                      tone="ghost"
                      size="sm"
                      label={`Remove field ${index + 1}`}
                      onClick={() =>
                        set(
                          'fields',
                          fields.filter((_, at) => at !== index),
                        )
                      }
                    />
                  </span>
                </div>
                <MessageField
                  placeholders={placeholders}
                  path={`${path}.fields.${index}.value`}
                  label={`Field ${index + 1} value`}
                  rows={2}
                  layout="wide"
                  maxLength={EMBED_FIELD_VALUE_MAX}
                  value={field.value}
                  error={errorAt(`${path}.fields.${index}.value`)}
                  empty={FIELD_TEXTLESS}
                  onChange={(next) => setField(index, { ...field, value: next })}
                />
              </div>
            ))}
          </Rows>
        )}

        <div style={{ marginTop: 10 }}>
          <Button tone="danger-quiet" size="sm" icon="trash" onClick={onRemove}>
            Remove embed
          </Button>
        </div>
      </Section>
    </>
  );
}

function ButtonRowEditor({
  guildId,
  row,
  path,
  onChange,
  onRemove,
  errorAt,
  placeholders,
}: {
  guildId: string;
  row: Extract<ActionRow, { kind: 'buttons' }>;
  path: string;
  onChange: (next: ActionRow) => void;
  onRemove: () => void;
  errorAt: ErrorAt;
  placeholders: PlaceholderSlot | undefined;
}): ReactElement {
  const recent = useRecent();

  const setButton = (index: number, next: MessageButton): void =>
    onChange({
      kind: 'buttons',
      buttons: row.buttons.map((button, at) => (at === index ? next : button)),
    });

  return (
    <Rows>
      {row.buttons.map((button, index) => {
        const at = `${path}.buttons.${index}`;

        return (
          <div className={cx('row stacked', recent.enter(button.key, 'part'))} key={button.key}>
            <div className="inline inline-8 inline-wrap">
              <EmojiPicker
                guildId={guildId}
                label={`Button ${index + 1} emoji`}
                value={button.emoji ?? null}
                onChange={(emoji) => setButton(index, { ...button, emoji: emoji ?? undefined })}
              />
              <MessageField
                placeholders={placeholders}
                path={`${at}.label`}
                label={`Button ${index + 1} label`}
                width="md"
                placeholder="Label"
                maxLength={BUTTON_LABEL_MAX}
                value={button.label ?? ''}
                error={errorAt(`${at}.label`)}
                onChange={(next) => setButton(index, { ...button, label: blank(next) })}
              />
              <Select
                aria-label={`Button ${index + 1} style`}
                className="control-w-sm"
                value={button.style}
                options={BUTTON_STYLES.map((style) => ({
                  value: style,
                  label: BUTTON_STYLE_LABELS[style] ?? style,
                }))}
                onChange={(value) =>
                  setButton(index, { ...button, style: value as MessageButton['style'] })
                }
              />
              <IconButton
                icon="trash"
                tone="ghost"
                size="sm"
                label={`Remove button ${index + 1}`}
                onClick={() =>
                  onChange({
                    kind: 'buttons',
                    buttons: row.buttons.filter((_, position) => position !== index),
                  })
                }
              />
            </div>

            {button.style === 'link' ? (
              <MessageField
                placeholders={placeholders}
                path={`${at}.url`}
                label={`Button ${index + 1} link`}
                link
                placeholder="https://…"
                maxLength={BUTTON_URL_MAX}
                value={button.url ?? ''}
                error={errorAt(`${at}.url`)}
                onChange={(next) => setButton(index, { ...button, url: blank(next) })}
              />
            ) : button.action ? (
              <p className="row-note">
                Proton handles this button
                {button.action.kind === 'role' ? ' — it changes a role' : ' — it replies'}. Only its
                module can change what it does.
              </p>
            ) : null}
          </div>
        );
      })}

      <div className="row">
        <Button
          size="sm"
          icon="plus"
          disabled={row.buttons.length >= 5}
          onClick={() => {
            const key = `b${row.buttons.length + 1}`;
            recent.mark(key);
            onChange({
              kind: 'buttons',
              buttons: [...row.buttons, { key, style: 'link', label: 'Button', url: '' }],
            });
          }}
        >
          Add button
        </Button>
        <span className="push-right">
          <Button tone="ghost" size="sm" icon="trash" onClick={onRemove}>
            Remove row
          </Button>
        </span>
      </div>
    </Rows>
  );
}

function SelectRowEditor({
  row,
  path,
  onChange,
  onRemove,
  errorAt,
  placeholders,
}: {
  row: Extract<ActionRow, { kind: 'select' }>;
  path: string;
  onChange: (next: ActionRow) => void;
  onRemove: () => void;
  errorAt: ErrorAt;
  placeholders: PlaceholderSlot | undefined;
}): ReactElement {
  const { select } = row;

  return (
    <Rows>
      <SettingRow title="Prompt" description="Shown in the dropdown before anything is chosen.">
        <MessageField
          placeholders={placeholders}
          path={`${path}.select.placeholder`}
          label="Dropdown prompt"
          width="lg"
          value={select.placeholder ?? ''}
          error={errorAt(`${path}.select.placeholder`)}
          onChange={(next) =>
            onChange({ kind: 'select', select: { ...select, placeholder: blank(next) } })
          }
        />
      </SettingRow>

      {select.options.map((option, index) => (
        <div className="row" key={option.key}>
          <div className="row-main inline inline-8">
            <MessageField
              placeholders={placeholders}
              path={`${path}.select.options.${index}.label`}
              label={`Option ${index + 1} label`}
              width="md"
              maxLength={SELECT_OPTION_LABEL_MAX}
              value={option.label}
              error={errorAt(`${path}.select.options.${index}.label`)}
              onChange={(next) =>
                onChange({
                  kind: 'select',
                  select: {
                    ...select,
                    options: select.options.map((current, at) =>
                      at === index ? { ...current, label: next } : current,
                    ),
                  },
                })
              }
            />
          </div>
          <div className="row-control">
            <IconButton
              icon="trash"
              tone="ghost"
              size="sm"
              label={`Remove option ${index + 1}`}
              onClick={() =>
                onChange({
                  kind: 'select',
                  select: { ...select, options: select.options.filter((_, at) => at !== index) },
                })
              }
            />
          </div>
        </div>
      ))}

      <div className="row">
        <span className="text-xs text-muted">
          Proton handles every option, so only the module that owns this dropdown can add one.
          Options can be renamed here.
        </span>
        <span className="push-right">
          <Button tone="ghost" size="sm" icon="trash" onClick={onRemove}>
            Remove dropdown
          </Button>
        </span>
      </div>
    </Rows>
  );
}

export function MessageEditor({
  guildId,
  value,
  onChange,
  allow,
  placeholders,
  contentLabel = 'Message',
  contentDescription,
  errorAt,
  pathPrefix,
}: MessageEditorProps): ReactElement {
  const recent = useRecent();
  const prefix = pathPrefix === undefined ? '' : `${pathPrefix}.`;
  const errorFor: ErrorAt = (path) => errorAt?.(path);

  const content = value.content ?? '';
  const embed = value.embeds[0];

  const replaceRow = (index: number, next: ActionRow): void =>
    onChange({
      ...value,
      components: value.components.map((current, at) => (at === index ? next : current)),
    });

  const removeRow = (index: number): void =>
    onChange({ ...value, components: value.components.filter((_, at) => at !== index) });

  return (
    <>
      <Section label="Content">
        <Rows>
          <SettingRow title={contentLabel} description={contentDescription} stacked>
            <MessageField
              placeholders={placeholders}
              path={`${prefix}content`}
              label={contentLabel}
              rows={5}
              layout="wide"
              maxLength={MESSAGE_CONTENT_MAX}
              value={content}
              error={errorFor(`${prefix}content`)}
              note={countLabel(content.length, MESSAGE_CONTENT_MAX)}
              onChange={(next) => onChange({ ...value, content: next })}
            />
          </SettingRow>
        </Rows>
      </Section>

      {allow?.embed !== false ? (
        embed ? (
          <Section label="Embed">
            <SingleEmbedEditor
              embed={embed}
              path={`${prefix}embeds.0`}
              className={recent.enter('embed', 'part')}
              errorAt={errorFor}
              placeholders={placeholders}
              onChange={(next) => onChange({ ...value, embeds: [next, ...value.embeds.slice(1)] })}
              onRemove={() => onChange({ ...value, embeds: value.embeds.slice(1) })}
            />
          </Section>
        ) : (
          <Section label="Embed">
            <Rows>
              <SettingRow
                title="No embed"
                description="Show a block with a title, colour, fields and images below the text."
              >
                <Button
                  size="sm"
                  icon="plus"
                  onClick={() => {
                    recent.mark('embed');
                    onChange({
                      ...value,
                      embeds: [
                        { description: '', color: DEFAULT_EMBED_COLOUR },
                        ...value.embeds.slice(1),
                      ],
                    });
                  }}
                >
                  Add embed
                </Button>
              </SettingRow>
            </Rows>
          </Section>
        )
      ) : null}

      {allow?.components !== false ? (
        <Section
          label="Buttons and dropdowns"
          actions={
            <Button
              size="sm"
              icon="plus"
              disabled={value.components.length >= 5}
              onClick={() => {
                recent.mark(value.components.length);
                onChange({
                  ...value,
                  components: [
                    ...value.components,
                    {
                      kind: 'buttons',
                      buttons: [
                        {
                          key: `b${value.components.length + 1}`,
                          style: 'link',
                          label: 'Button',
                          url: '',
                        },
                      ],
                    },
                  ],
                });
              }}
            >
              Add button row
            </Button>
          }
        >
          {value.components.length === 0 ? (
            <p className="section-intro">No buttons or dropdowns.</p>
          ) : (
            <div className="stack stack-10">
              {value.components.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
                <div key={index} className={recent.enter(index, 'part')}>
                  {row.kind === 'buttons' ? (
                    <ButtonRowEditor
                      guildId={guildId}
                      row={row}
                      path={`${prefix}components.${index}`}
                      errorAt={errorFor}
                      placeholders={placeholders}
                      onChange={(next) => replaceRow(index, next)}
                      onRemove={() => removeRow(index)}
                    />
                  ) : (
                    <SelectRowEditor
                      row={row}
                      path={`${prefix}components.${index}`}
                      errorAt={errorFor}
                      placeholders={placeholders}
                      onChange={(next) => replaceRow(index, next)}
                      onRemove={() => removeRow(index)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      ) : null}

      {allow?.mentions !== false ? (
        <Section
          label="Mentions"
          intro="Choose who this message can ping. Mentions that are off still show but do not notify anyone."
        >
          <Rows>
            <SettingRow title="@everyone and @here">
              <Switch
                label="Ping @everyone and @here"
                checked={value.mentions.everyone}
                onChange={(next) =>
                  onChange({ ...value, mentions: { ...value.mentions, everyone: next } })
                }
              />
            </SettingRow>
            <SettingRow title="Roles">
              <Switch
                label="Ping roles"
                checked={value.mentions.roles}
                onChange={(next) =>
                  onChange({ ...value, mentions: { ...value.mentions, roles: next } })
                }
              />
            </SettingRow>
            <SettingRow title="Members">
              <Switch
                label="Ping members"
                checked={value.mentions.users}
                onChange={(next) =>
                  onChange({ ...value, mentions: { ...value.mentions, users: next } })
                }
              />
            </SettingRow>
          </Rows>
        </Section>
      ) : null}
    </>
  );
}

export function EditorPreviewLayout({
  editor,
  preview,
  previewTitle = 'Discord preview',
  previewActions,
}: {
  editor: ReactNode;
  preview: ReactNode;
  previewTitle?: string | undefined;
  previewActions?: ReactNode;
}): ReactElement {
  return (
    <div className="editor">
      <div className="editor-main">{editor}</div>
      <div className="editor-preview">
        <div className="editor-preview-head">
          <span className="editor-preview-title">{previewTitle}</span>
          {previewActions}
        </div>
        {preview}
      </div>
    </div>
  );
}

export { Icon };
