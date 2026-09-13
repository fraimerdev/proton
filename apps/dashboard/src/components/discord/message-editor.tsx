import type { ActionRow, Embed, MessageButton, ProtonMessage } from '@proton/core';
import {
  BUTTON_LABEL_MAX,
  BUTTON_STYLES,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_TEXT_MAX,
  EMBED_TITLE_MAX,
  MESSAGE_CONTENT_MAX,
  SELECT_OPTION_LABEL_MAX,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useRecent } from '../ui/collection.tsx';
import { Button, cx, IconButton, Select, Switch, TextArea, TextInput } from '../ui/controls.tsx';
import { Icon } from '../ui/icon.tsx';
import { Rows, Section, SettingRow } from '../ui/layout.tsx';
import { Popover } from '../ui/overlay.tsx';
import { EmojiPicker } from './emoji-picker.tsx';
import { ColourPicker, DEFAULT_EMBED_COLOUR } from './inputs.tsx';

export type EditableMessage = Pick<ProtonMessage, 'content' | 'embeds' | 'components' | 'mentions'>;

export interface MessageVariable {
  token: string;
  describes: string;
}

interface MessageEditorProps {
  guildId: string;
  value: EditableMessage;
  onChange: (next: EditableMessage) => void;
  /** Which parts of a message this surface is allowed to author. */
  allow?:
    | {
        embed?: boolean | undefined;
        components?: boolean | undefined;
        mentions?: boolean | undefined;
      }
    | undefined;
  variables?: readonly MessageVariable[] | undefined;
  contentLabel?: string | undefined;
  contentDescription?: ReactNode;
  errorAt?: ((path: string) => string | undefined) | undefined;
  /** Prefix for the paths errorAt is asked about, e.g. "panel" -> "panel.content". */
  pathPrefix?: string | undefined;
}

const BUTTON_STYLE_LABELS: Record<string, string> = {
  primary: 'Blurple',
  secondary: 'Grey',
  success: 'Green',
  danger: 'Red',
  link: 'Link',
};

function countLabel(used: number, max: number): string {
  return `${used} / ${max}`;
}

function VariableMenu({
  variables,
  onInsert,
}: {
  variables: readonly MessageVariable[];
  onInsert: (token: string) => void;
}): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        ref={anchor}
        tone="secondary"
        size="sm"
        trailingIcon="caret-down"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Insert placeholder
      </Button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        minWidth={260}
      >
        <div role="menu">
          {variables.map((variable) => (
            <button
              key={variable.token}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                onInsert(variable.token);
                setOpen(false);
              }}
            >
              <span className="mono">{variable.token}</span>
              <span className="push-right text-xs text-muted">{variable.describes}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function EmbedEditor({
  embed,
  onChange,
  onRemove,
  errorAt,
  prefix,
  className,
}: {
  embed: Embed;
  onChange: (next: Embed) => void;
  onRemove: () => void;
  errorAt: (path: string) => string | undefined;
  prefix: string;
  className?: string | undefined;
}): ReactElement {
  const recent = useRecent();

  const set = <K extends keyof Embed>(key: K, value: Embed[K]): void =>
    onChange({ ...embed, [key]: value });

  const fields = embed.fields ?? [];

  return (
    <>
      <Rows className={className}>
        <SettingRow title="Title" error={errorAt(`${prefix}.title`)}>
          <TextInput
            width="lg"
            aria-label="Embed title"
            maxLength={EMBED_TITLE_MAX}
            value={embed.title ?? ''}
            onChange={(event) => set('title', event.currentTarget.value || undefined)}
          />
        </SettingRow>

        <SettingRow
          title="Description"
          description="Supports Discord markdown."
          stacked
          error={errorAt(`${prefix}.description`)}
          note={countLabel((embed.description ?? '').length, EMBED_DESCRIPTION_MAX)}
        >
          <TextArea
            aria-label="Embed description"
            rows={5}
            maxLength={EMBED_DESCRIPTION_MAX}
            value={embed.description ?? ''}
            onChange={(event) => set('description', event.currentTarget.value || undefined)}
          />
        </SettingRow>

        <SettingRow title="Colour" description="The bar down the left edge of the embed.">
          <ColourPicker
            label="Embed colour"
            value={embed.color ?? DEFAULT_EMBED_COLOUR}
            onChange={(next) => set('color', next)}
          />
        </SettingRow>

        <SettingRow title="Footer" error={errorAt(`${prefix}.footer.text`)}>
          <TextInput
            width="lg"
            aria-label="Embed footer"
            maxLength={EMBED_FOOTER_TEXT_MAX}
            value={embed.footer?.text ?? ''}
            onChange={(event) =>
              set(
                'footer',
                event.currentTarget.value ? { text: event.currentTarget.value } : undefined,
              )
            }
          />
        </SettingRow>

        <SettingRow title="Image" description="Shown full width under the text.">
          <TextInput
            width="lg"
            aria-label="Embed image URL"
            placeholder="https://…"
            value={embed.imageUrl ?? ''}
            onChange={(event) => set('imageUrl', event.currentTarget.value || undefined)}
          />
        </SettingRow>

        <SettingRow title="Thumbnail" description="Shown small, top right.">
          <TextInput
            width="lg"
            aria-label="Embed thumbnail URL"
            placeholder="https://…"
            value={embed.thumbnailUrl ?? ''}
            onChange={(event) => set('thumbnailUrl', event.currentTarget.value || undefined)}
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
                  <TextInput
                    aria-label={`Field ${index + 1} name`}
                    className="control-w-md"
                    maxLength={EMBED_FIELD_NAME_MAX}
                    value={field.name}
                    onChange={(event) =>
                      set(
                        'fields',
                        fields.map((current, at) =>
                          at === index ? { ...current, name: event.currentTarget.value } : current,
                        ),
                      )
                    }
                  />
                  <span className="push-right inline inline-8">
                    <span className="text-xs text-muted">Inline</span>
                    <Switch
                      label={`Field ${index + 1} inline`}
                      checked={field.inline === true}
                      onChange={(next) =>
                        set(
                          'fields',
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
                      onClick={() =>
                        set(
                          'fields',
                          fields.filter((_, at) => at !== index),
                        )
                      }
                    />
                  </span>
                </div>
                <TextArea
                  aria-label={`Field ${index + 1} value`}
                  rows={2}
                  maxLength={EMBED_FIELD_VALUE_MAX}
                  value={field.value}
                  onChange={(event) =>
                    set(
                      'fields',
                      fields.map((current, at) =>
                        at === index ? { ...current, value: event.currentTarget.value } : current,
                      ),
                    )
                  }
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
  onChange,
  onRemove,
  errorAt,
  prefix,
}: {
  guildId: string;
  row: Extract<ActionRow, { kind: 'buttons' }>;
  onChange: (next: ActionRow) => void;
  onRemove: () => void;
  errorAt: (path: string) => string | undefined;
  prefix: string;
}): ReactElement {
  const recent = useRecent();

  const setButton = (index: number, next: MessageButton): void =>
    onChange({
      kind: 'buttons',
      buttons: row.buttons.map((button, at) => (at === index ? next : button)),
    });

  return (
    <Rows>
      {row.buttons.map((button, index) => (
        <div className={cx('row stacked', recent.enter(button.key, 'part'))} key={button.key}>
          <div className="inline inline-8 inline-wrap">
            <EmojiPicker
              guildId={guildId}
              label={`Button ${index + 1} emoji`}
              value={button.emoji ?? null}
              onChange={(emoji) => setButton(index, { ...button, emoji: emoji ?? undefined })}
            />
            <TextInput
              aria-label={`Button ${index + 1} label`}
              className="control-w-md"
              placeholder="Label"
              maxLength={BUTTON_LABEL_MAX}
              invalid={errorAt(`${prefix}.${index}.label`) !== undefined}
              value={button.label ?? ''}
              onChange={(event) =>
                setButton(index, { ...button, label: event.currentTarget.value || undefined })
              }
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
                onChange({ kind: 'buttons', buttons: row.buttons.filter((_, at) => at !== index) })
              }
            />
          </div>

          {button.style === 'link' ? (
            <>
              <TextInput
                aria-label={`Button ${index + 1} link`}
                placeholder="https://…"
                invalid={errorAt(`${prefix}.${index}.url`) !== undefined}
                value={button.url ?? ''}
                onChange={(event) =>
                  setButton(index, { ...button, url: event.currentTarget.value || undefined })
                }
              />
              {errorAt(`${prefix}.${index}.url`) !== undefined ? (
                <p className="row-error">{errorAt(`${prefix}.${index}.url`)}</p>
              ) : null}
            </>
          ) : button.action ? (
            <p className="row-note">
              Proton handles this button
              {button.action.kind === 'role' ? ' — it changes a role' : ' — it replies'}. Only its
              module can change what it does.
            </p>
          ) : null}
        </div>
      ))}

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
  onChange,
  onRemove,
}: {
  row: Extract<ActionRow, { kind: 'select' }>;
  onChange: (next: ActionRow) => void;
  onRemove: () => void;
}): ReactElement {
  const { select } = row;

  return (
    <Rows>
      <SettingRow
        title="Placeholder"
        description="Shown in the dropdown before anything is chosen."
      >
        <TextInput
          width="lg"
          aria-label="Dropdown placeholder"
          value={select.placeholder ?? ''}
          onChange={(event) =>
            onChange({
              kind: 'select',
              select: { ...select, placeholder: event.currentTarget.value || undefined },
            })
          }
        />
      </SettingRow>

      {select.options.map((option, index) => (
        <div className="row" key={option.key}>
          <div className="row-main inline inline-8">
            <TextInput
              aria-label={`Option ${index + 1} label`}
              className="control-w-md"
              maxLength={SELECT_OPTION_LABEL_MAX}
              value={option.label}
              onChange={(event) =>
                onChange({
                  kind: 'select',
                  select: {
                    ...select,
                    options: select.options.map((current, at) =>
                      at === index ? { ...current, label: event.currentTarget.value } : current,
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

/**
 * The authoring half of an editor+preview page. Put it in `.editor-main` with `DiscordPreview` in
 * `.editor-preview` beside it.
 */
export function MessageEditor({
  guildId,
  value,
  onChange,
  allow,
  variables,
  contentLabel = 'Message',
  contentDescription,
  errorAt,
  pathPrefix,
}: MessageEditorProps): ReactElement {
  const content = useRef<HTMLTextAreaElement>(null);
  const recent = useRecent();
  const prefix = pathPrefix === undefined ? '' : `${pathPrefix}.`;
  const error = (path: string): string | undefined => errorAt?.(`${prefix}${path}`);

  const embed = value.embeds[0];

  const insert = (token: string): void => {
    const field = content.current;
    const at = field?.selectionStart ?? (value.content ?? '').length;
    const text = value.content ?? '';

    onChange({ ...value, content: `${text.slice(0, at)}${token}${text.slice(at)}` });
    queueMicrotask(() => {
      field?.focus();
      field?.setSelectionRange(at + token.length, at + token.length);
    });
  };

  return (
    <>
      <Section
        label="Content"
        actions={
          variables && variables.length > 0 ? (
            <VariableMenu variables={variables} onInsert={insert} />
          ) : null
        }
      >
        <Rows>
          <SettingRow
            title={contentLabel}
            description={contentDescription}
            stacked
            error={error('content')}
            note={countLabel((value.content ?? '').length, MESSAGE_CONTENT_MAX)}
          >
            <TextArea
              ref={content}
              aria-label={contentLabel}
              rows={5}
              maxLength={MESSAGE_CONTENT_MAX}
              invalid={error('content') !== undefined}
              value={value.content ?? ''}
              onChange={(event) => onChange({ ...value, content: event.currentTarget.value })}
            />
          </SettingRow>
        </Rows>
      </Section>

      {allow?.embed !== false ? (
        embed ? (
          <Section label="Embed">
            <EmbedEditor
              embed={embed}
              className={recent.enter('embed', 'part')}
              prefix={`${prefix}embeds.0`}
              errorAt={(path) => errorAt?.(path)}
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
                      prefix={`${prefix}components.${index}.buttons`}
                      errorAt={(path) => errorAt?.(path)}
                      onChange={(next) =>
                        onChange({
                          ...value,
                          components: value.components.map((current, at) =>
                            at === index ? next : current,
                          ),
                        })
                      }
                      onRemove={() =>
                        onChange({
                          ...value,
                          components: value.components.filter((_, at) => at !== index),
                        })
                      }
                    />
                  ) : (
                    <SelectRowEditor
                      row={row}
                      onChange={(next) =>
                        onChange({
                          ...value,
                          components: value.components.map((current, at) =>
                            at === index ? next : current,
                          ),
                        })
                      }
                      onRemove={() =>
                        onChange({
                          ...value,
                          components: value.components.filter((_, at) => at !== index),
                        })
                      }
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
