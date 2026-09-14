import type { ActionRow, ComponentAction, MessageButton, SelectOption } from '@proton/core';
import {
  BUTTON_LABEL_MAX,
  BUTTON_STYLES,
  BUTTON_URL_MAX,
  BUTTONS_PER_ROW_MAX,
  COMPONENT_KEY_MAX,
  REPLY_ACTION_CONTENT_MAX,
  ROLE_ACTION_MODES,
  SELECT_OPTION_DESCRIPTION_MAX,
  SELECT_OPTION_LABEL_MAX,
  SELECT_OPTIONS_MAX,
  SELECT_PLACEHOLDER_MAX,
} from '@proton/core';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import {
  blank,
  MessageField,
  type PlaceholderSlot,
  sentence,
} from '../../components/discord/embed-editor.tsx';
import { EmojiPicker } from '../../components/discord/emoji-picker.tsx';
import { DiscordPreview } from '../../components/discord/message-preview.tsx';
import { RolePicker } from '../../components/discord/role-picker.tsx';
import { useRecent } from '../../components/ui/collection.tsx';
import {
  Button,
  cx,
  Field,
  IconButton,
  NumberStepper,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from '../../components/ui/controls.tsx';
import { Rows } from '../../components/ui/layout.tsx';
import {
  BUTTON_STYLE_LABELS,
  DEFAULT_ACTION,
  freshKey,
  NEEDS_MANAGE_ROLES,
  newButton,
  type ReplyPreview,
  ROLE_MODE_HELP,
  ROLE_MODE_LABELS,
} from './shared.ts';

export interface KeyContext {
  counts: ReadonlyMap<string, number>;
  taken: ReadonlySet<string>;
  subject: 'message' | 'row';
  // Null in the palette, where the message name the id is built from is not known yet.
  customId: ((key: string) => { length: number; problem: string | undefined }) | null;
}

const DUPLICATE = (key: string, subject: 'message' | 'row'): string =>
  `two components in this ${subject} are both keyed '${key}'. The key is what a press carries ` +
  'back, so Proton could not tell which one was pressed.';

const LINK_KEY_UNUSED = 'Link buttons open their link directly, so this key is not used.';

const ACTION_KINDS = [
  { value: 'role' as const, label: 'Give or remove a role' },
  { value: 'reply' as const, label: 'Reply' },
];

const REPLY_EMPTY = 'Filled in for this sample, the reply is empty, so Proton would send nothing.';

// Not Field: these controls take no id, so its <label for> would point at nothing.
export function Labelled({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  className?: string | undefined;
}): ReactElement {
  return (
    <div className={cx('field', className)}>
      <span className="field-label">{label}</span>
      {children}
      {error !== undefined ? (
        <span className="field-error">{error}</span>
      ) : hint !== undefined ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

function KeyField({
  label,
  value,
  onChange,
  keys,
  routed,
  error,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  keys: KeyContext;
  routed: boolean;
  error: string | undefined;
}): ReactElement {
  const encoded = routed ? keys.customId?.(value) : undefined;
  const clash =
    routed && (keys.counts.get(value) ?? 0) > 1 ? DUPLICATE(value, keys.subject) : undefined;

  const hint = !routed
    ? LINK_KEY_UNUSED
    : encoded
      ? `${encoded.length} / 100 characters, including the template name`
      : undefined;

  return (
    <div className="messages-field-grow">
      <Field label={label} hint={hint} error={error ?? clash ?? encoded?.problem}>
        {(props) => (
          <TextInput
            {...props}
            className="mono"
            width="sm"
            maxLength={COMPONENT_KEY_MAX}
            invalid={(error ?? clash ?? encoded?.problem) !== undefined}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        )}
      </Field>
    </div>
  );
}

function ReplySample({ preview }: { preview: ReplyPreview }): ReactElement {
  return (
    <div>
      <DiscordPreview
        message={{ content: preview.text }}
        mentionNames={preview.mentionNames}
        now={preview.now}
        empty={REPLY_EMPTY}
      />
      <p className="messages-preview-note text-xs text-muted">{preview.caption}</p>
      {preview.notes.map((note) => (
        <p key={note} className="messages-preview-note text-xs text-muted">
          {sentence(note)}
        </p>
      ))}
    </div>
  );
}

function ActionEditor({
  guildId,
  action,
  onChange,
  errorAt,
  prefix,
  placeholders,
  previewReply,
}: {
  guildId: string;
  action: ComponentAction;
  onChange: (next: ComponentAction) => void;
  errorAt: (path: string) => string | undefined;
  prefix: string;
  placeholders: PlaceholderSlot | undefined;
  previewReply: ((text: string) => ReplyPreview) | undefined;
}): ReactElement {
  const [switched, setSwitched] = useState(false);
  const fade = switched ? 'motion-fade' : undefined;

  return (
    <div className="stack stack-8">
      <div className="messages-fields">
        <Labelled label="Action">
          <SegmentedControl
            label="Action"
            options={ACTION_KINDS}
            value={action.kind}
            onChange={(kind) => {
              setSwitched(true);
              onChange(
                kind === 'role'
                  ? { kind: 'role', mode: 'toggle', roleId: '' }
                  : { kind: 'reply', content: '', ephemeral: true },
              );
            }}
          />
        </Labelled>

        {action.kind === 'role' ? (
          <>
            <div className={fade}>
              <Field label="Mode" hint={ROLE_MODE_HELP[action.mode]}>
                {(props) => (
                  <Select
                    {...props}
                    width="sm"
                    value={action.mode}
                    options={ROLE_ACTION_MODES.map((mode) => ({
                      value: mode,
                      label: ROLE_MODE_LABELS[mode] ?? mode,
                    }))}
                    onChange={(value) =>
                      onChange({
                        ...action,
                        mode: value as (typeof ROLE_ACTION_MODES)[number],
                      })
                    }
                  />
                )}
              </Field>
            </div>

            <Labelled className={fade} label="Role" error={errorAt(`${prefix}.roleId`)}>
              <RolePicker
                guildId={guildId}
                label="Role"
                width={216}
                allowNone={false}
                invalid={errorAt(`${prefix}.roleId`) !== undefined}
                value={action.roleId === '' ? null : action.roleId}
                onChange={(roleId) => onChange({ ...action, roleId: roleId ?? '' })}
              />
            </Labelled>
          </>
        ) : null}
      </div>

      {action.kind === 'role' ? <p className={cx('row-note', fade)}>{NEEDS_MANAGE_ROLES}</p> : null}

      {action.kind === 'reply' ? (
        <div className={cx('stack stack-8', fade)}>
          <Labelled label="Reply">
            <MessageField
              placeholders={placeholders}
              path={`${prefix}.content`}
              label="Reply"
              rows={2}
              layout="wide"
              maxLength={REPLY_ACTION_CONTENT_MAX}
              value={action.content}
              error={errorAt(`${prefix}.content`)}
              note={`${action.content.length} / ${REPLY_ACTION_CONTENT_MAX}`}
              onChange={(content) => onChange({ ...action, content })}
            />
          </Labelled>

          {previewReply !== undefined && action.content.trim() !== '' ? (
            <ReplySample preview={previewReply(action.content)} />
          ) : null}

          <div className="inline inline-8">
            <Switch
              label="Reply privately"
              checked={action.ephemeral}
              onChange={(next) => onChange({ ...action, ephemeral: next })}
            />
            <span className="text-sm text-secondary">Reply privately</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ButtonEditor({
  guildId,
  button,
  index,
  keys,
  errorAt,
  prefix,
  onChange,
  onRemove,
  className,
  placeholders,
  previewReply,
}: {
  guildId: string;
  button: MessageButton;
  index: number;
  keys: KeyContext;
  errorAt: (path: string) => string | undefined;
  prefix: string;
  onChange: (next: MessageButton) => void;
  onRemove: () => void;
  className?: string | undefined;
  placeholders: PlaceholderSlot | undefined;
  previewReply: ((text: string) => ReplyPreview) | undefined;
}): ReactElement {
  const link = button.style === 'link';

  return (
    <div className={cx('row stacked', className)}>
      <div className="messages-fields">
        <Labelled label="Emoji">
          <EmojiPicker
            guildId={guildId}
            label={`Button ${index + 1} emoji`}
            value={button.emoji ?? null}
            onChange={(emoji) => onChange({ ...button, emoji: emoji ?? undefined })}
          />
        </Labelled>

        <div className="messages-field-grow">
          <Labelled label="Label">
            <MessageField
              placeholders={placeholders}
              path={`${prefix}.label`}
              label={`Button ${index + 1} label`}
              width="md"
              maxLength={BUTTON_LABEL_MAX}
              value={button.label ?? ''}
              error={errorAt(`${prefix}.label`)}
              onChange={(label) => onChange({ ...button, label: blank(label) })}
            />
          </Labelled>
        </div>

        <Field label="Style">
          {(props) => (
            <Select
              {...props}
              width="sm"
              value={button.style}
              options={BUTTON_STYLES.map((style) => ({
                value: style,
                label: BUTTON_STYLE_LABELS[style] ?? style,
              }))}
              onChange={(value) => {
                const style = value as MessageButton['style'];

                onChange(
                  style === 'link'
                    ? { ...button, style, url: button.url ?? '', action: undefined }
                    : { ...button, style, url: undefined, action: button.action ?? DEFAULT_ACTION },
                );
              }}
            />
          )}
        </Field>

        <KeyField
          label="Key"
          value={button.key}
          routed={!link}
          keys={keys}
          error={errorAt(`${prefix}.key`)}
          onChange={(key) => onChange({ ...button, key })}
        />

        <Labelled label="Disabled">
          <Switch
            label={`Button ${index + 1} disabled`}
            checked={button.disabled === true}
            onChange={(next) => onChange({ ...button, disabled: next || undefined })}
          />
        </Labelled>

        <span className="push-right">
          <IconButton
            icon="trash"
            tone="ghost"
            size="sm"
            label={`Remove button ${index + 1}`}
            onClick={onRemove}
          />
        </span>
      </div>

      {link ? (
        <Labelled label="Link">
          <MessageField
            placeholders={placeholders}
            path={`${prefix}.url`}
            label={`Button ${index + 1} link`}
            link
            placeholder="https://…"
            maxLength={BUTTON_URL_MAX}
            value={button.url ?? ''}
            error={errorAt(`${prefix}.url`)}
            onChange={(url) => onChange({ ...button, url })}
          />
        </Labelled>
      ) : (
        <>
          <ActionEditor
            guildId={guildId}
            action={button.action ?? DEFAULT_ACTION}
            prefix={`${prefix}.action`}
            errorAt={errorAt}
            placeholders={placeholders}
            previewReply={previewReply}
            onChange={(action) => onChange({ ...button, action })}
          />
          {errorAt(`${prefix}.action`) !== undefined ? (
            <p className="row-error">{errorAt(`${prefix}.action`)}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function OptionEditor({
  guildId,
  option,
  index,
  keys,
  errorAt,
  prefix,
  onChange,
  onRemove,
  removable,
  className,
  placeholders,
  previewReply,
}: {
  guildId: string;
  option: SelectOption;
  index: number;
  keys: KeyContext;
  errorAt: (path: string) => string | undefined;
  prefix: string;
  onChange: (next: SelectOption) => void;
  onRemove: () => void;
  removable: boolean;
  className?: string | undefined;
  placeholders: PlaceholderSlot | undefined;
  previewReply: ((text: string) => ReplyPreview) | undefined;
}): ReactElement {
  return (
    <div className={cx('row stacked', className)}>
      <div className="messages-fields">
        <Labelled label="Emoji">
          <EmojiPicker
            guildId={guildId}
            label={`Option ${index + 1} emoji`}
            value={option.emoji ?? null}
            onChange={(emoji) => onChange({ ...option, emoji: emoji ?? undefined })}
          />
        </Labelled>

        <div className="messages-field-grow">
          <Labelled label="Label">
            <MessageField
              placeholders={placeholders}
              path={`${prefix}.label`}
              label={`Option ${index + 1} label`}
              width="md"
              maxLength={SELECT_OPTION_LABEL_MAX}
              value={option.label}
              error={errorAt(`${prefix}.label`)}
              onChange={(label) => onChange({ ...option, label })}
            />
          </Labelled>
        </div>

        <div className="messages-field-grow">
          <Labelled label="Description">
            <MessageField
              placeholders={placeholders}
              path={`${prefix}.description`}
              label={`Option ${index + 1} description`}
              width="md"
              maxLength={SELECT_OPTION_DESCRIPTION_MAX}
              value={option.description ?? ''}
              error={errorAt(`${prefix}.description`)}
              onChange={(description) => onChange({ ...option, description: blank(description) })}
            />
          </Labelled>
        </div>

        <KeyField
          label="Key"
          value={option.key}
          routed
          keys={keys}
          error={errorAt(`${prefix}.key`)}
          onChange={(key) => onChange({ ...option, key })}
        />

        <Labelled label="Selected by default">
          <Switch
            label={`Option ${index + 1} selected by default`}
            checked={option.default === true}
            onChange={(next) => onChange({ ...option, default: next || undefined })}
          />
        </Labelled>

        {removable ? (
          <span className="push-right">
            <IconButton
              icon="trash"
              tone="ghost"
              size="sm"
              label={`Remove option ${index + 1}`}
              onClick={onRemove}
            />
          </span>
        ) : null}
      </div>

      <ActionEditor
        guildId={guildId}
        action={option.action}
        prefix={`${prefix}.action`}
        errorAt={errorAt}
        placeholders={placeholders}
        previewReply={previewReply}
        onChange={(action) => onChange({ ...option, action })}
      />
    </div>
  );
}

export function RowEditor({
  guildId,
  row,
  keys,
  errorAt,
  prefix,
  onChange,
  onRemove,
  placeholders,
  previewReply,
}: {
  guildId: string;
  row: ActionRow;
  keys: KeyContext;
  errorAt: (path: string) => string | undefined;
  prefix: string;
  onChange: (next: ActionRow) => void;
  onRemove: () => void;
  placeholders?: PlaceholderSlot | undefined;
  previewReply?: ((text: string) => ReplyPreview) | undefined;
}): ReactElement {
  const recent = useRecent();

  if (row.kind === 'select') {
    const { select } = row;
    const change = (next: typeof select): void => onChange({ kind: 'select', select: next });

    return (
      <Rows>
        <div className="row stacked">
          <div className="messages-fields">
            <div className="messages-field-grow">
              <Labelled label="Prompt" hint="Shown before a member picks an option.">
                <MessageField
                  placeholders={placeholders}
                  path={`${prefix}.select.placeholder`}
                  label="Dropdown prompt"
                  width="lg"
                  maxLength={SELECT_PLACEHOLDER_MAX}
                  value={select.placeholder ?? ''}
                  error={errorAt(`${prefix}.select.placeholder`)}
                  onChange={(placeholder) => change({ ...select, placeholder: blank(placeholder) })}
                />
              </Labelled>
            </div>

            <KeyField
              label="Key"
              value={select.key}
              routed
              keys={keys}
              error={errorAt(`${prefix}.select.key`)}
              onChange={(key) => change({ ...select, key })}
            />

            <Labelled label="Pick at least">
              <NumberStepper
                label="Pick at least"
                width={96}
                min={0}
                max={SELECT_OPTIONS_MAX}
                value={select.minValues ?? null}
                onChange={(next) => change({ ...select, minValues: next ?? undefined })}
              />
            </Labelled>

            <Labelled label="Pick at most" error={errorAt(`${prefix}.select.maxValues`)}>
              <NumberStepper
                label="Pick at most"
                width={96}
                min={1}
                max={SELECT_OPTIONS_MAX}
                invalid={errorAt(`${prefix}.select.maxValues`) !== undefined}
                value={select.maxValues ?? null}
                onChange={(next) => change({ ...select, maxValues: next ?? undefined })}
              />
            </Labelled>

            <Labelled label="Disabled">
              <Switch
                label="Dropdown disabled"
                checked={select.disabled === true}
                onChange={(next) => change({ ...select, disabled: next || undefined })}
              />
            </Labelled>
          </div>
          <p className="row-note">
            Leave both empty to let members pick exactly one option. Each picked option runs its
            action.
          </p>
        </div>

        {select.options.map((option, index) => (
          <OptionEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: an option's position is its identity while its key is being typed
            key={index}
            className={recent.enter(index, 'part')}
            guildId={guildId}
            option={option}
            index={index}
            keys={keys}
            errorAt={errorAt}
            prefix={`${prefix}.select.options.${index}`}
            removable={select.options.length > 1}
            placeholders={placeholders}
            previewReply={previewReply}
            onChange={(next) =>
              change({
                ...select,
                options: select.options.map((current, at) => (at === index ? next : current)),
              })
            }
            onRemove={() =>
              change({ ...select, options: select.options.filter((_, at) => at !== index) })
            }
          />
        ))}

        <div className="row">
          <Button
            size="sm"
            icon="plus"
            disabled={select.options.length >= SELECT_OPTIONS_MAX}
            onClick={() => {
              recent.mark(select.options.length);
              change({
                ...select,
                options: [
                  ...select.options,
                  {
                    key: freshKey('option', keys.taken),
                    label: 'Option',
                    action: { kind: 'reply', content: '', ephemeral: true },
                  },
                ],
              });
            }}
          >
            Add option
          </Button>
          <span className="push-right">
            <Button tone="danger-quiet" size="sm" icon="trash" onClick={onRemove}>
              Remove dropdown
            </Button>
          </span>
        </div>
      </Rows>
    );
  }

  const { buttons } = row;

  return (
    <Rows>
      {buttons.map((button, index) => (
        <ButtonEditor
          // biome-ignore lint/suspicious/noArrayIndexKey: a button's position is its identity while its key is being typed
          key={index}
          className={recent.enter(index, 'part')}
          guildId={guildId}
          button={button}
          index={index}
          keys={keys}
          errorAt={errorAt}
          prefix={`${prefix}.buttons.${index}`}
          placeholders={placeholders}
          previewReply={previewReply}
          onChange={(next) =>
            onChange({
              kind: 'buttons',
              buttons: buttons.map((current, at) => (at === index ? next : current)),
            })
          }
          onRemove={() => {
            // A row with no buttons is invalid, so removing the last button removes the row.
            if (buttons.length === 1) onRemove();
            else onChange({ kind: 'buttons', buttons: buttons.filter((_, at) => at !== index) });
          }}
        />
      ))}

      <div className="row">
        <Button
          size="sm"
          icon="plus"
          disabled={buttons.length >= BUTTONS_PER_ROW_MAX}
          onClick={() => {
            recent.mark(buttons.length);
            onChange({ kind: 'buttons', buttons: [...buttons, newButton(keys.taken)] });
          }}
        >
          Add button
        </Button>
        <span className="push-right">
          <Button tone="danger-quiet" size="sm" icon="trash" onClick={onRemove}>
            Remove row
          </Button>
        </span>
      </div>
    </Rows>
  );
}
