import type {
  ActionRow,
  ButtonStyle,
  ComponentAction,
  ContainerChild,
  Embed,
  EmbedAuthor,
  EmbedField,
  EmbedFooter,
  MediaItem,
  MentionPolicy,
  MessageButton,
  MessageSelect,
  ProtonMessage,
  RoleActionMode,
  SelectOption,
  SeparatorSpacing,
  V2Component,
} from '@proton/core';
import {
  ACTION_ROWS_MAX,
  BUTTON_LABEL_MAX,
  BUTTON_STYLES,
  BUTTONS_PER_ROW_MAX,
  countV2Components,
  EMBED_AUTHOR_NAME_MAX,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_NAME_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_FIELDS_MAX,
  EMBED_FOOTER_TEXT_MAX,
  EMBED_TITLE_MAX,
  EMBED_TOTAL_MAX,
  EMBEDS_PER_MESSAGE_MAX,
  embedsLength,
  formatComponentEmoji,
  MEDIA_DESCRIPTION_MAX,
  MEDIA_GALLERY_ITEMS_MAX,
  MESSAGE_CONTENT_MAX,
  messageSchema,
  parseComponentEmoji,
  REPLY_ACTION_CONTENT_MAX,
  ROLE_ACTION_MODES,
  SECTION_TEXT_MAX,
  SELECT_OPTION_DESCRIPTION_MAX,
  SELECT_OPTION_LABEL_MAX,
  SELECT_OPTIONS_MAX,
  SELECT_PLACEHOLDER_MAX,
  SEPARATOR_SPACINGS,
  V2_COMPONENTS_MAX,
  v2AccessoryButtons,
  v2Rows,
} from '@proton/core';
import { withFreshKeys } from '@proton/module-messages/config';
import { type ReactElement, useId, useState } from 'react';
import {
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
} from '../form/picker.tsx';
import { Icon } from '../shell/icon.tsx';

export interface PaletteRow {
  name: string;
  row: ActionRow;
}

export interface MessageBuilderProps {
  message: ProtonMessage;
  onChange: (message: ProtonMessage) => void;
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];

  palette?: readonly PaletteRow[];
}

type InvalidAt = (path: string) => boolean;

const BUTTON_STYLE_LABELS: Record<ButtonStyle, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  success: 'Success',
  danger: 'Danger',
  link: 'Link',
};

const ROLE_MODE_LABELS: Record<RoleActionMode, string> = {
  toggle: 'Toggle — press to get the role, press again to lose it',
  add: 'Add only — the role is never taken back',
  remove: 'Remove only',
};

const EMOJI_PLACEHOLDER = 'A unicode emoji, or <:name:123456789012345678>';

function replaced<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((entry, i) => (i === index ? item : entry));
}

function removed<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const item = next[from];
  if (item === undefined || to < 0 || to >= list.length) return next;

  next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function blank(value: string): string | undefined {
  return value === '' ? undefined : value;
}

export function usedKeys(rows: readonly ActionRow[]): Set<string> {
  const keys = new Set<string>();

  for (const row of rows) {
    if (row.kind === 'buttons') {
      for (const button of row.buttons) keys.add(button.key);
      continue;
    }

    keys.add(row.select.key);
    for (const option of row.select.options) keys.add(option.key);
  }

  return keys;
}

function freshKey(prefix: string, taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

export function blankButton(taken: ReadonlySet<string>): MessageButton {
  return {
    key: freshKey('button', taken),
    style: 'secondary',
    label: 'Press me',
    action: { kind: 'role', mode: 'toggle', roleId: '' },
  };
}

export function blankSelect(taken: ReadonlySet<string>): MessageSelect {
  const key = freshKey('menu', taken);

  return {
    key,
    options: [
      {
        key: freshKey('option', new Set([...taken, key])),
        label: 'Choice 1',
        action: { kind: 'role', mode: 'toggle', roleId: '' },
      },
    ],
  };
}

function layoutKeys(components: readonly V2Component[]): Set<string> {
  const keys = usedKeys(v2Rows(components));
  for (const key of v2AccessoryButtons(components)) keys.add(key);
  return keys;
}

type V2Kind = V2Component['kind'];

const V2_KIND_LABELS: Record<V2Kind, string> = {
  text: 'Text',
  separator: 'Separator',
  gallery: 'Pictures',
  section: 'Section',
  row: 'Buttons or a dropdown',
  container: 'Container',
};

const CHILD_KINDS: readonly V2Kind[] = ['text', 'separator', 'gallery', 'section', 'row'];
const TOP_KINDS: readonly V2Kind[] = [...CHILD_KINDS, 'container'];

const SPACING_LABELS: Record<SeparatorSpacing, string> = {
  small: 'Small',
  large: 'Large',
};

function blankNode(kind: V2Kind, taken: ReadonlySet<string>): V2Component {
  switch (kind) {
    case 'text':
      return { kind: 'text', content: 'Text' };
    case 'separator':
      return { kind: 'separator', divider: true, spacing: 'small' };
    case 'gallery':
      return { kind: 'gallery', items: [{ url: '' }] };
    case 'section':
      return { kind: 'section', text: ['Text'], accessory: { kind: 'thumbnail', url: '' } };
    case 'row':
      return { kind: 'row', row: { kind: 'buttons', buttons: [blankButton(taken)] } };
    case 'container':
      return { kind: 'container', children: [{ kind: 'text', content: 'Text' }] };
  }
}

function isChild(node: V2Component): node is ContainerChild {
  return node.kind !== 'container';
}

const INDEXED: Record<string, string> = {
  embeds: 'Embed',
  fields: 'Field',
  components: 'Row',
  buttons: 'Button',
  options: 'Option',
};

const GROUPS: Record<string, string> = {
  embeds: 'Embeds',
  fields: 'Fields',
  components: 'Buttons and dropdowns',
  buttons: 'Buttons',
  options: 'Options',
};

const LABELS: Record<string, string> = {
  content: 'message text',
  mentions: 'mentions',
  everyone: '@everyone',
  roles: 'role mentions',
  users: 'member mentions',
  title: 'title',
  description: 'description',
  url: 'link',
  color: 'colour',
  timestamp: 'timestamp',
  author: 'author',
  footer: 'footer',
  imageUrl: 'image',
  thumbnailUrl: 'thumbnail',
  iconUrl: 'icon',
  name: 'name',
  text: 'text',
  value: 'text',
  inline: 'inline',
  key: 'key',
  style: 'style',
  label: 'label',
  emoji: 'emoji',
  disabled: 'disabled',
  action: 'action',
  select: 'dropdown',
  placeholder: 'placeholder',
  minValues: 'at least',
  maxValues: 'at most',
  mode: 'mode',
  roleId: 'role',
  ephemeral: 'private reply',
  default: 'picked by default',
  kind: 'kind',
};

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

const V2_INDEXED: Record<string, string> = {
  ...INDEXED,
  v2: 'Layout',
  children: 'Container child',
  items: 'Picture',
  text: 'Text',
};

const V2_GROUPS: Record<string, string> = {
  ...GROUPS,
  v2: 'Layout',
  children: 'Container children',
  items: 'Pictures',
  text: 'Text',
};

const V2_LABELS: Record<string, string> = {
  ...LABELS,
  content: 'text',
  accessory: 'accessory',
  accentColor: 'accent colour',
  spoiler: 'spoiler',
  divider: 'divider',
  spacing: 'spacing',
  row: 'row',
  button: 'button',
};

interface PathWords {
  indexed: Record<string, string>;
  groups: Record<string, string>;
  labels: Record<string, string>;
}

const CLASSIC_WORDS: PathWords = { indexed: INDEXED, groups: GROUPS, labels: LABELS };
const LAYOUT_WORDS: PathWords = { indexed: V2_INDEXED, groups: V2_GROUPS, labels: V2_LABELS };

function describePath(path: readonly PropertyKey[]): string {
  const words = path[0] === 'v2' ? LAYOUT_WORDS : CLASSIC_WORDS;
  const parts: string[] = [];

  for (let i = 0; i < path.length; i += 1) {
    const step = path[i];
    const key = String(step);
    const noun = words.indexed[key];

    if (noun !== undefined) {
      const at = path[i + 1];
      if (typeof at === 'number') {
        parts.push(`${noun} ${at + 1}`);
        i += 1;
      } else {
        parts.push(words.groups[key] ?? key);
      }
      continue;
    }

    if (typeof step === 'number') {
      parts.push(`item ${step + 1}`);
      continue;
    }

    parts.push(words.labels[key] ?? key);
  }

  if (parts.length === 0) return '';

  return `${parts.map((part, i) => (i === 0 ? upperFirst(part) : lowerFirst(part))).join(', ')}: `;
}

interface CounterInputProps {
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  invalid?: boolean;
}

function CounterInput({
  label,
  value,
  max,
  onChange,
  multiline = false,
  rows = 3,
  invalid = false,
}: CounterInputProps): ReactElement {
  const over = value.length > max;

  const head = (
    <span>
      {label}
      <span className="builder-count" data-over={over ? 'true' : undefined}>
        {value.length}/{max}
      </span>
    </span>
  );

  if (multiline) {
    return (
      <label className="filter builder-counted">
        {head}
        <textarea
          rows={rows}
          value={value}
          maxLength={max}
          aria-invalid={invalid || over}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  return (
    <label className="filter builder-counted">
      {head}
      <input
        type="text"
        value={value}
        maxLength={max}
        aria-invalid={invalid || over}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

interface LineInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  invalid?: boolean;
}

function LineInput({
  label,
  value,
  onChange,
  placeholder,
  invalid = false,
}: LineInputProps): ReactElement {
  return (
    <label className="filter">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

interface SwitchFieldProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function SwitchField({ label, description, checked, onChange }: SwitchFieldProps): ReactElement {
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

interface RolePickerProps {
  label: string;
  roleId: string;
  roles: readonly DiscordRole[];
  invalid: boolean;
  onChange: (roleId: string) => void;
}

function RolePicker({ label, roleId, roles, invalid, onChange }: RolePickerProps): ReactElement {
  const id = useId();
  const controlId = `${id}-control`;

  return (
    <div className="filter">
      <span>
        <label htmlFor={controlId}>{label}</label>
      </span>
      <SinglePicker
        id={controlId}
        label={label}
        options={roleOptions(roles)}
        value={roleId === '' ? null : roleId}
        onChange={(next) => onChange(next ?? '')}
        emptyLabel="Choose a role…"
        clearable={false}
        invalid={invalid}
      />
    </div>
  );
}

interface OrderActionsProps {
  label: string;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  canRemove?: boolean;
}

function OrderActions({
  label,
  index,
  count,
  onMove,
  onRemove,
  canRemove = true,
}: OrderActionsProps): ReactElement {
  return (
    <span className="builder-actions">
      <button
        type="button"
        className="button button-ghost"
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        <Icon name="caret-up" />
      </button>
      <button
        type="button"
        className="button button-ghost"
        aria-label={`Move ${label} down`}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <Icon name="caret-down" />
      </button>
      <button
        type="button"
        className="button button-ghost"
        aria-label={`Remove ${label}`}
        disabled={!canRemove}
        onClick={onRemove}
      >
        <Icon name="trash" />
      </button>
    </span>
  );
}

const HEX = /^#?[0-9a-fA-F]{6}$/;

function hexText(color: number | undefined): string {
  return color === undefined ? '' : `#${color.toString(16).padStart(6, '0')}`;
}

function fromHex(raw: string): number | undefined {
  const value = raw.trim();
  return HEX.test(value) ? Number.parseInt(value.replace('#', ''), 16) : undefined;
}

interface ColorInputProps {
  color: number | undefined;
  onChange: (color: number | undefined) => void;
}

function ColorInput({ color, onChange }: ColorInputProps): ReactElement {
  const errorId = useId();
  const [seen, setSeen] = useState(color);
  const [draft, setDraft] = useState(() => hexText(color));

  // Held, not derived: a controlled hex field reverts every keystroke before the sixth.
  if (seen !== color) {
    setSeen(color);
    setDraft(hexText(color));
  }

  const wrong = draft.trim() !== '' && fromHex(draft) === undefined;

  function commit(raw: string): void {
    setDraft(raw);
    if (raw.trim() === '') {
      onChange(undefined);
      return;
    }

    const parsed = fromHex(raw);
    if (parsed !== undefined) onChange(parsed);
  }

  return (
    <span className="builder-colour">
      <label className="filter">
        <span>Colour</span>
        <input
          type="color"
          value={color === undefined ? '#000000' : hexText(color)}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(fromHex(e.target.value));
          }}
        />
      </label>
      <label className="filter">
        <span>Hex</span>
        <input
          type="text"
          value={draft}
          placeholder="#5865F2"
          aria-invalid={wrong}
          aria-describedby={wrong ? errorId : undefined}
          // Blur resyncs too, or reordering carries a half-typed draft onto another embed.
          onBlur={() => setDraft(hexText(color))}
          onChange={(e) => commit(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="button button-ghost"
        disabled={color === undefined && draft === ''}
        onClick={() => {
          setDraft('');
          onChange(undefined);
        }}
      >
        No colour
      </button>
      {wrong ? (
        <span className="field-error" id={errorId}>
          A colour is six hex digits, like #5865F2. The colour above stays until this reads as one.
        </span>
      ) : null}
    </span>
  );
}

// datetime-local speaks local wall-clock with no zone; the stored timestamp keeps its offset.
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

interface ActionEditorProps {
  action: ComponentAction | undefined;
  legend: string;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  onChange: (action: ComponentAction | undefined) => void;
}

function ActionEditor({
  action,
  legend,
  path,
  invalid,
  roles,
  onChange,
}: ActionEditorProps): ReactElement {
  function setKind(kind: string): void {
    if (kind === 'role') {
      onChange({ kind: 'role', mode: 'toggle', roleId: '' });
      return;
    }
    if (kind === 'reply') {
      onChange({ kind: 'reply', content: '', ephemeral: true });
      return;
    }
    onChange(undefined);
  }

  return (
    <fieldset className="builder-group">
      <legend>{legend}</legend>

      <label className="filter">
        <span>When it is used</span>
        <select
          value={action?.kind ?? ''}
          aria-invalid={action === undefined || invalid(path)}
          onChange={(e) => setKind(e.target.value)}
        >
          {action === undefined ? <option value="">Choose what it does…</option> : null}
          <option value="role">Give or take a role</option>
          <option value="reply">Reply with a message</option>
        </select>
      </label>

      {action?.kind === 'role' ? (
        <>
          <label className="filter">
            <span>How</span>
            <select
              value={action.mode}
              onChange={(e) => onChange({ ...action, mode: e.target.value as RoleActionMode })}
            >
              {ROLE_ACTION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {ROLE_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          <RolePicker
            label="Role"
            roleId={action.roleId}
            roles={roles}
            invalid={action.roleId === '' || invalid(`${path}.roleId`)}
            onChange={(roleId) => onChange({ ...action, roleId })}
          />
        </>
      ) : null}

      {action?.kind === 'reply' ? (
        <>
          <CounterInput
            label="Reply text"
            multiline
            rows={2}
            max={REPLY_ACTION_CONTENT_MAX}
            value={action.content}
            invalid={action.content.trim() === '' || invalid(`${path}.content`)}
            onChange={(content) => onChange({ ...action, content })}
          />
          <SwitchField
            label="Only the member who used it sees the reply"
            checked={action.ephemeral}
            onChange={(ephemeral) => onChange({ ...action, ephemeral })}
          />
        </>
      ) : null}
    </fieldset>
  );
}

interface ButtonEditorProps {
  button: MessageButton;
  index: number;
  count: number;
  name: string;
  title?: string;
  legend?: string;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  onChange: (button: MessageButton) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function ButtonEditor({
  button,
  index,
  count,
  name,
  title,
  legend,
  path,
  invalid,
  roles,
  onChange,
  onMove,
  onRemove,
}: ButtonEditorProps): ReactElement {
  function setStyle(style: ButtonStyle): void {
    onChange(
      style === 'link'
        ? { ...button, style, action: undefined }
        : { ...button, style, url: undefined },
    );
  }

  return (
    <div className="builder-row">
      <span className="builder-head">
        <span className="builder-head-title">{title ?? `Button ${index + 1}`}</span>
        <OrderActions
          label={name}
          index={index}
          count={count}
          onMove={onMove}
          onRemove={onRemove}
          canRemove={count > 1}
        />
      </span>

      <label className="filter">
        <span>Key</span>
        <input
          type="text"
          value={button.key}
          placeholder="claim-role"
          aria-invalid={button.key === '' || invalid(`${path}.key`)}
          onChange={(e) => onChange({ ...button, key: e.target.value })}
        />
      </label>

      <label className="filter">
        <span>Style</span>
        <select value={button.style} onChange={(e) => setStyle(e.target.value as ButtonStyle)}>
          {BUTTON_STYLES.map((style) => (
            <option key={style} value={style}>
              {BUTTON_STYLE_LABELS[style]}
            </option>
          ))}
        </select>
      </label>

      <CounterInput
        label="Label"
        value={button.label ?? ''}
        max={BUTTON_LABEL_MAX}
        invalid={invalid(`${path}.label`)}
        onChange={(value) => onChange({ ...button, label: blank(value) })}
      />

      <LineInput
        label="Emoji"
        value={formatComponentEmoji(button.emoji)}
        placeholder={EMOJI_PLACEHOLDER}
        invalid={invalid(`${path}.emoji`)}
        onChange={(value) => onChange({ ...button, emoji: parseComponentEmoji(value) })}
      />

      <SwitchField
        label="Greyed out and unpressable"
        checked={button.disabled === true}
        onChange={(disabled) => onChange({ ...button, disabled })}
      />

      {button.style === 'link' ? (
        <LineInput
          label="Opens"
          value={button.url ?? ''}
          placeholder="https://example.com"
          invalid={invalid(`${path}.url`)}
          onChange={(value) => onChange({ ...button, url: blank(value) })}
        />
      ) : (
        <ActionEditor
          action={button.action}
          legend={legend ?? `What button ${index + 1} does`}
          path={`${path}.action`}
          invalid={invalid}
          roles={roles}
          onChange={(action) => onChange({ ...button, action })}
        />
      )}
    </div>
  );
}

interface SelectOptionEditorProps {
  option: SelectOption;
  index: number;
  count: number;
  rowIndex: number;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  onChange: (option: SelectOption) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function SelectOptionEditor({
  option,
  index,
  count,
  rowIndex,
  path,
  invalid,
  roles,
  onChange,
  onMove,
  onRemove,
}: SelectOptionEditorProps): ReactElement {
  return (
    <div className="builder-row">
      <span className="builder-head">
        <span className="builder-head-title">Option {index + 1}</span>
        <OrderActions
          label={`option ${index + 1} of row ${rowIndex + 1}`}
          index={index}
          count={count}
          onMove={onMove}
          onRemove={onRemove}
          canRemove={count > 1}
        />
      </span>

      <label className="filter">
        <span>Key</span>
        <input
          type="text"
          value={option.key}
          aria-invalid={option.key === '' || invalid(`${path}.key`)}
          onChange={(e) => onChange({ ...option, key: e.target.value })}
        />
      </label>

      <CounterInput
        label="Label"
        value={option.label}
        max={SELECT_OPTION_LABEL_MAX}
        invalid={option.label.trim() === '' || invalid(`${path}.label`)}
        onChange={(label) => onChange({ ...option, label })}
      />

      <CounterInput
        label="Description"
        value={option.description ?? ''}
        max={SELECT_OPTION_DESCRIPTION_MAX}
        invalid={invalid(`${path}.description`)}
        onChange={(value) => onChange({ ...option, description: blank(value) })}
      />

      <LineInput
        label="Emoji"
        value={formatComponentEmoji(option.emoji)}
        placeholder={EMOJI_PLACEHOLDER}
        invalid={invalid(`${path}.emoji`)}
        onChange={(value) => onChange({ ...option, emoji: parseComponentEmoji(value) })}
      />

      <SwitchField
        label="Already picked when the dropdown is drawn"
        checked={option.default === true}
        onChange={(value) => onChange({ ...option, default: value })}
      />

      <ActionEditor
        action={option.action}
        legend={`What option ${index + 1} does`}
        path={`${path}.action`}
        invalid={invalid}
        roles={roles}
        onChange={(action) => onChange(action === undefined ? option : { ...option, action })}
      />
    </div>
  );
}

interface SelectEditorProps {
  select: MessageSelect;
  rowIndex: number;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  taken: ReadonlySet<string>;
  onChange: (select: MessageSelect) => void;
}

function SelectEditor({
  select,
  rowIndex,
  path,
  invalid,
  roles,
  taken,
  onChange,
}: SelectEditorProps): ReactElement {
  const options = select.options;

  return (
    <div className="builder-select-editor">
      <label className="filter">
        <span>Key</span>
        <input
          type="text"
          value={select.key}
          placeholder="pick-a-colour"
          aria-invalid={select.key === '' || invalid(`${path}.key`)}
          onChange={(e) => onChange({ ...select, key: e.target.value })}
        />
      </label>

      <CounterInput
        label="Placeholder"
        value={select.placeholder ?? ''}
        max={SELECT_PLACEHOLDER_MAX}
        invalid={invalid(`${path}.placeholder`)}
        onChange={(value) => onChange({ ...select, placeholder: blank(value) })}
      />

      <label className="filter">
        <span>Pick at least</span>
        <input
          type="number"
          min={0}
          max={SELECT_OPTIONS_MAX}
          value={select.minValues ?? ''}
          aria-invalid={invalid(`${path}.minValues`)}
          onChange={(e) =>
            onChange({
              ...select,
              minValues: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </label>

      <label className="filter">
        <span>Pick at most</span>
        <input
          type="number"
          min={1}
          max={SELECT_OPTIONS_MAX}
          value={select.maxValues ?? ''}
          aria-invalid={invalid(`${path}.maxValues`)}
          onChange={(e) =>
            onChange({
              ...select,
              maxValues: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </label>

      <SwitchField
        label="Greyed out and unusable"
        checked={select.disabled === true}
        onChange={(disabled) => onChange({ ...select, disabled })}
      />

      {options.map((option, index) => (
        <SelectOptionEditor
          // biome-ignore lint/suspicious/noArrayIndexKey: the key field is itself edited here
          key={`option-${index}`}
          option={option}
          index={index}
          count={options.length}
          rowIndex={rowIndex}
          path={`${path}.options.${index}`}
          invalid={invalid}
          roles={roles}
          onChange={(next) => onChange({ ...select, options: replaced(options, index, next) })}
          onMove={(to) => onChange({ ...select, options: moved(options, index, to) })}
          onRemove={() => onChange({ ...select, options: removed(options, index) })}
        />
      ))}

      <button
        type="button"
        className="button button-quiet"
        disabled={options.length >= SELECT_OPTIONS_MAX}
        onClick={() =>
          onChange({
            ...select,
            options: [
              ...options,
              {
                key: freshKey('option', taken),
                label: `Choice ${options.length + 1}`,
                action: { kind: 'role', mode: 'toggle', roleId: '' },
              },
            ],
          })
        }
      >
        {options.length >= SELECT_OPTIONS_MAX
          ? `Limit of ${SELECT_OPTIONS_MAX} options reached`
          : `Add option to row ${rowIndex + 1}`}
      </button>
    </div>
  );
}

export interface RowEditorProps {
  row: ActionRow;
  index: number;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  taken: ReadonlySet<string>;
  onChange: (row: ActionRow) => void;
}

export function RowEditor({
  row,
  index,
  path,
  invalid,
  roles,
  taken,
  onChange,
}: RowEditorProps): ReactElement {
  function setKind(kind: string): void {
    onChange(
      kind === 'select'
        ? { kind: 'select', select: blankSelect(taken) }
        : { kind: 'buttons', buttons: [blankButton(taken)] },
    );
  }

  return (
    <>
      <label className="filter">
        <span>This row is</span>
        <select value={row.kind} onChange={(e) => setKind(e.target.value)}>
          <option value="buttons">Buttons</option>
          <option value="select">A dropdown</option>
        </select>
      </label>

      {row.kind === 'buttons' ? (
        <>
          {row.buttons.map((button, buttonIndex) => (
            <ButtonEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: the key field is itself edited here
              key={`button-${buttonIndex}`}
              button={button}
              index={buttonIndex}
              count={row.buttons.length}
              name={`button ${buttonIndex + 1} of row ${index + 1}`}
              path={`${path}.buttons.${buttonIndex}`}
              invalid={invalid}
              roles={roles}
              onChange={(next) =>
                onChange({ kind: 'buttons', buttons: replaced(row.buttons, buttonIndex, next) })
              }
              onMove={(to) =>
                onChange({ kind: 'buttons', buttons: moved(row.buttons, buttonIndex, to) })
              }
              onRemove={() =>
                onChange({ kind: 'buttons', buttons: removed(row.buttons, buttonIndex) })
              }
            />
          ))}

          <button
            type="button"
            className="button button-quiet"
            disabled={row.buttons.length >= BUTTONS_PER_ROW_MAX}
            onClick={() =>
              onChange({ kind: 'buttons', buttons: [...row.buttons, blankButton(taken)] })
            }
          >
            {row.buttons.length >= BUTTONS_PER_ROW_MAX
              ? `Limit of ${BUTTONS_PER_ROW_MAX} buttons in a row reached`
              : `Add button to row ${index + 1}`}
          </button>
        </>
      ) : (
        <SelectEditor
          select={row.select}
          rowIndex={index}
          path={`${path}.select`}
          invalid={invalid}
          roles={roles}
          taken={taken}
          onChange={(select) => onChange({ kind: 'select', select })}
        />
      )}
    </>
  );
}

interface ComponentsEditorProps {
  rows: readonly ActionRow[];
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  palette: readonly PaletteRow[];
  onChange: (rows: ActionRow[]) => void;
}

function ComponentsEditor({
  rows,
  invalid,
  roles,
  palette,
  onChange,
}: ComponentsEditorProps): ReactElement {
  const taken = usedKeys(rows);
  const full = rows.length >= ACTION_ROWS_MAX;

  return (
    <>
      <p className="field-description">
        Every row is one line under the message. A row holds up to {BUTTONS_PER_ROW_MAX} buttons, or
        one dropdown. The key is what a press carries back to Proton, so it has to be unique across
        the whole message.
      </p>

      {rows.map((row, index) => (
        <div
          className="ladder-rung ladder-rung-stacked builder-rung"
          // biome-ignore lint/suspicious/noArrayIndexKey: rows carry no id, and their keys are edited
          key={`row-${index}`}
        >
          <span className="builder-head">
            <span className="builder-head-title">Row {index + 1}</span>
            <span className="pill">{row.kind === 'buttons' ? 'Buttons' : 'Dropdown'}</span>
            <OrderActions
              label={`row ${index + 1}`}
              index={index}
              count={rows.length}
              onMove={(to) => onChange(moved(rows, index, to))}
              onRemove={() => onChange(removed(rows, index))}
            />
          </span>

          <RowEditor
            row={row}
            index={index}
            path={`components.${index}`}
            invalid={invalid}
            roles={roles}
            taken={taken}
            onChange={(next) => onChange(replaced(rows, index, next))}
          />
        </div>
      ))}

      {rows.length === 0 ? (
        <p className="field-empty">
          No buttons or dropdowns. The message is posted as plain text and embeds.
        </p>
      ) : null}

      <div className="builder-add-row">
        <button
          type="button"
          className="button button-quiet"
          disabled={full}
          onClick={() => onChange([...rows, { kind: 'buttons', buttons: [blankButton(taken)] }])}
        >
          {full ? `Limit of ${ACTION_ROWS_MAX} rows reached` : 'Add row'}
        </button>

        {palette.length === 0 ? null : (
          <label className="filter">
            <span>Insert a saved component</span>
            <select
              disabled={full}
              value=""
              onChange={(event) => {
                const entry = palette[Number(event.target.value)];
                if (!entry) return;

                onChange([...rows, withFreshKeys(entry.row, taken)]);
              }}
            >
              <option value="">Choose one…</option>
              {palette.map((entry, index) => (
                <option key={entry.name} value={index}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </>
  );
}

interface EmbedFieldsEditorProps {
  fields: readonly EmbedField[];
  embedIndex: number;
  path: string;
  invalid: InvalidAt;
  onChange: (fields: EmbedField[]) => void;
}

function EmbedFieldsEditor({
  fields,
  embedIndex,
  path,
  invalid,
  onChange,
}: EmbedFieldsEditorProps): ReactElement {
  return (
    <fieldset className="builder-group">
      <legend>Fields</legend>

      {fields.map((field, index) => (
        <div
          className="builder-row"
          // biome-ignore lint/suspicious/noArrayIndexKey: fields carry no id of their own
          key={`field-${index}`}
        >
          <span className="builder-head">
            <span className="builder-head-title">Field {index + 1}</span>
            <OrderActions
              label={`field ${index + 1} of embed ${embedIndex + 1}`}
              index={index}
              count={fields.length}
              onMove={(to) => onChange(moved(fields, index, to))}
              onRemove={() => onChange(removed(fields, index))}
            />
          </span>

          <CounterInput
            label="Name"
            value={field.name}
            max={EMBED_FIELD_NAME_MAX}
            invalid={field.name.trim() === '' || invalid(`${path}.${index}.name`)}
            onChange={(name) => onChange(replaced(fields, index, { ...field, name }))}
          />

          <CounterInput
            label="Text"
            multiline
            rows={2}
            value={field.value}
            max={EMBED_FIELD_VALUE_MAX}
            invalid={field.value.trim() === '' || invalid(`${path}.${index}.value`)}
            onChange={(value) => onChange(replaced(fields, index, { ...field, value }))}
          />

          <SwitchField
            label="Sits beside the field before it"
            checked={field.inline === true}
            onChange={(inline) => onChange(replaced(fields, index, { ...field, inline }))}
          />
        </div>
      ))}

      {fields.length === 0 ? <p className="field-empty">No fields on this embed.</p> : null}

      <button
        type="button"
        className="button button-quiet"
        disabled={fields.length >= EMBED_FIELDS_MAX}
        onClick={() => onChange([...fields, { name: 'Name', value: 'Text' }])}
      >
        {fields.length >= EMBED_FIELDS_MAX
          ? `Limit of ${EMBED_FIELDS_MAX} fields reached`
          : `Add field to embed ${embedIndex + 1}`}
      </button>
    </fieldset>
  );
}

interface EmbedEditorProps {
  embed: Embed;
  index: number;
  count: number;
  path: string;
  invalid: InvalidAt;
  onChange: (embed: Embed) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function EmbedEditor({
  embed,
  index,
  count,
  path,
  invalid,
  onChange,
  onMove,
  onRemove,
}: EmbedEditorProps): ReactElement {
  const author = embed.author;
  const footer = embed.footer;

  const stamp = embed.timestamp;
  const stampMode = stamp === undefined ? 'none' : stamp === 'now' ? 'now' : 'fixed';

  function patch(next: Partial<Embed>): void {
    onChange({ ...embed, ...next });
  }

  function setAuthor(name: string, url: string | undefined, iconUrl: string | undefined): void {
    const empty = name.trim() === '' && url === undefined && iconUrl === undefined;
    const next: EmbedAuthor = {
      name,
      ...(url === undefined ? {} : { url }),
      ...(iconUrl === undefined ? {} : { iconUrl }),
    };

    patch({ author: empty ? undefined : next });
  }

  function setFooter(text: string, iconUrl: string | undefined): void {
    const empty = text.trim() === '' && iconUrl === undefined;
    const next: EmbedFooter = { text, ...(iconUrl === undefined ? {} : { iconUrl }) };

    patch({ footer: empty ? undefined : next });
  }

  function setStampMode(mode: string): void {
    if (mode === 'now') {
      patch({ timestamp: 'now' });
      return;
    }
    if (mode === 'fixed') {
      patch({ timestamp: stamp && stamp !== 'now' ? stamp : new Date().toISOString() });
      return;
    }
    patch({ timestamp: undefined });
  }

  return (
    <div className="ladder-rung ladder-rung-stacked builder-rung">
      <span className="builder-head">
        <span className="builder-head-title">Embed {index + 1}</span>
        <OrderActions
          label={`embed ${index + 1}`}
          index={index}
          count={count}
          onMove={onMove}
          onRemove={onRemove}
        />
      </span>

      <CounterInput
        label="Title"
        value={embed.title ?? ''}
        max={EMBED_TITLE_MAX}
        invalid={invalid(`${path}.title`)}
        onChange={(value) => patch({ title: blank(value) })}
      />

      <CounterInput
        label="Description"
        multiline
        rows={4}
        value={embed.description ?? ''}
        max={EMBED_DESCRIPTION_MAX}
        invalid={invalid(`${path}.description`)}
        onChange={(value) => patch({ description: blank(value) })}
      />

      <LineInput
        label="Title links to"
        value={embed.url ?? ''}
        placeholder="https://example.com"
        invalid={invalid(`${path}.url`)}
        onChange={(value) => patch({ url: blank(value) })}
      />

      <ColorInput color={embed.color} onChange={(color) => patch({ color })} />

      <fieldset className="builder-group">
        <legend>Author</legend>
        <CounterInput
          label="Name"
          value={author?.name ?? ''}
          max={EMBED_AUTHOR_NAME_MAX}
          invalid={invalid(`${path}.author.name`)}
          onChange={(value) => setAuthor(value, author?.url, author?.iconUrl)}
        />
        <LineInput
          label="Name links to"
          value={author?.url ?? ''}
          placeholder="https://example.com"
          invalid={invalid(`${path}.author.url`)}
          onChange={(value) => setAuthor(author?.name ?? '', blank(value), author?.iconUrl)}
        />
        <LineInput
          label="Icon"
          value={author?.iconUrl ?? ''}
          placeholder="https://example.com/avatar.png"
          invalid={invalid(`${path}.author.iconUrl`)}
          onChange={(value) => setAuthor(author?.name ?? '', author?.url, blank(value))}
        />
      </fieldset>

      <fieldset className="builder-group">
        <legend>Footer</legend>
        <CounterInput
          label="Text"
          value={footer?.text ?? ''}
          max={EMBED_FOOTER_TEXT_MAX}
          invalid={invalid(`${path}.footer.text`)}
          onChange={(value) => setFooter(value, footer?.iconUrl)}
        />
        <LineInput
          label="Icon"
          value={footer?.iconUrl ?? ''}
          placeholder="https://example.com/icon.png"
          invalid={invalid(`${path}.footer.iconUrl`)}
          onChange={(value) => setFooter(footer?.text ?? '', blank(value))}
        />
      </fieldset>

      <fieldset className="builder-group">
        <legend>Pictures</legend>
        <LineInput
          label="Image"
          value={embed.imageUrl ?? ''}
          placeholder="https://example.com/banner.png"
          invalid={invalid(`${path}.imageUrl`)}
          onChange={(value) => patch({ imageUrl: blank(value) })}
        />
        <LineInput
          label="Thumbnail"
          value={embed.thumbnailUrl ?? ''}
          placeholder="https://example.com/thumb.png"
          invalid={invalid(`${path}.thumbnailUrl`)}
          onChange={(value) => patch({ thumbnailUrl: blank(value) })}
        />
      </fieldset>

      <label className="filter">
        <span>Timestamp</span>
        <select value={stampMode} onChange={(e) => setStampMode(e.target.value)}>
          <option value="none">None</option>
          <option value="now">The moment it is posted</option>
          <option value="fixed">A fixed time</option>
        </select>
      </label>

      {stampMode === 'fixed' && stamp !== undefined && stamp !== 'now' ? (
        <label className="filter">
          <span>Shows</span>
          <input
            type="datetime-local"
            value={toLocalInput(stamp)}
            aria-invalid={invalid(`${path}.timestamp`)}
            onChange={(e) => patch({ timestamp: fromLocalInput(e.target.value) })}
          />
        </label>
      ) : null}

      <EmbedFieldsEditor
        fields={embed.fields ?? []}
        embedIndex={index}
        path={`${path}.fields`}
        invalid={invalid}
        onChange={(fields) => patch({ fields })}
      />
    </div>
  );
}
interface MediaFieldsProps {
  item: MediaItem;
  path: string;
  invalid: InvalidAt;
  onChange: (item: MediaItem) => void;
}

function MediaFields({ item, path, invalid, onChange }: MediaFieldsProps): ReactElement {
  return (
    <>
      <LineInput
        label="Picture"
        value={item.url}
        placeholder="https://example.com/picture.png"
        invalid={item.url.trim() === '' || invalid(`${path}.url`)}
        onChange={(url) => onChange({ ...item, url })}
      />

      <CounterInput
        label="Alt text"
        value={item.description ?? ''}
        max={MEDIA_DESCRIPTION_MAX}
        invalid={invalid(`${path}.description`)}
        onChange={(value) => onChange({ ...item, description: blank(value) })}
      />

      <SwitchField
        label="Hidden until someone clicks it"
        checked={item.spoiler === true}
        onChange={(spoiler) => onChange({ ...item, spoiler })}
      />
    </>
  );
}

interface NodeBodyProps {
  node: V2Component;
  index: number;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  taken: ReadonlySet<string>;
  onChange: (node: V2Component) => void;
}

function NodeBody({
  node,
  index,
  path,
  invalid,
  roles,
  taken,
  onChange,
}: NodeBodyProps): ReactElement {
  switch (node.kind) {
    case 'text':
      return (
        <label className="filter">
          <span>Text</span>
          <textarea
            rows={4}
            value={node.content}
            aria-invalid={node.content.trim() === '' || invalid(`${path}.content`)}
            onChange={(e) => onChange({ ...node, content: e.target.value })}
          />
        </label>
      );

    case 'separator':
      return (
        <>
          <SwitchField
            label="Draw a line"
            description="Off, the separator is blank space with no rule through it."
            checked={node.divider}
            onChange={(divider) => onChange({ ...node, divider })}
          />
          <label className="filter">
            <span>Space around it</span>
            <select
              value={node.spacing}
              onChange={(e) => onChange({ ...node, spacing: e.target.value as SeparatorSpacing })}
            >
              {SEPARATOR_SPACINGS.map((spacing) => (
                <option key={spacing} value={spacing}>
                  {SPACING_LABELS[spacing]}
                </option>
              ))}
            </select>
          </label>
        </>
      );

    case 'gallery':
      return (
        <>
          {node.items.map((item, itemIndex) => (
            <div
              className="builder-row"
              // biome-ignore lint/suspicious/noArrayIndexKey: pictures carry no id of their own
              key={`item-${itemIndex}`}
            >
              <span className="builder-head">
                <span className="builder-head-title">Picture {itemIndex + 1}</span>
                <OrderActions
                  label={`picture ${itemIndex + 1}`}
                  index={itemIndex}
                  count={node.items.length}
                  onMove={(to) => onChange({ ...node, items: moved(node.items, itemIndex, to) })}
                  onRemove={() => onChange({ ...node, items: removed(node.items, itemIndex) })}
                  canRemove={node.items.length > 1}
                />
              </span>

              <MediaFields
                item={item}
                path={`${path}.items.${itemIndex}`}
                invalid={invalid}
                onChange={(next) =>
                  onChange({ ...node, items: replaced(node.items, itemIndex, next) })
                }
              />
            </div>
          ))}

          <button
            type="button"
            className="button button-quiet"
            disabled={node.items.length >= MEDIA_GALLERY_ITEMS_MAX}
            onClick={() => onChange({ ...node, items: [...node.items, { url: '' }] })}
          >
            {node.items.length >= MEDIA_GALLERY_ITEMS_MAX
              ? `Limit of ${MEDIA_GALLERY_ITEMS_MAX} pictures reached`
              : 'Add picture'}
          </button>
        </>
      );

    case 'section':
      return (
        <>
          <p className="field-description">
            Up to {SECTION_TEXT_MAX} blocks of text with one thing beside them. Discord needs that
            accessory — a section without one is refused.
          </p>

          {node.text.map((entry, textIndex) => (
            <div
              className="builder-row"
              // biome-ignore lint/suspicious/noArrayIndexKey: these are bare strings, not records
              key={`text-${textIndex}`}
            >
              <span className="builder-head">
                <span className="builder-head-title">Text {textIndex + 1}</span>
                <OrderActions
                  label={`text ${textIndex + 1}`}
                  index={textIndex}
                  count={node.text.length}
                  onMove={(to) => onChange({ ...node, text: moved(node.text, textIndex, to) })}
                  onRemove={() => onChange({ ...node, text: removed(node.text, textIndex) })}
                  canRemove={node.text.length > 1}
                />
              </span>

              <label className="filter">
                <span>Text</span>
                <textarea
                  rows={2}
                  value={entry}
                  aria-invalid={entry.trim() === '' || invalid(`${path}.text.${textIndex}`)}
                  onChange={(e) =>
                    onChange({ ...node, text: replaced(node.text, textIndex, e.target.value) })
                  }
                />
              </label>
            </div>
          ))}

          <button
            type="button"
            className="button button-quiet"
            disabled={node.text.length >= SECTION_TEXT_MAX}
            onClick={() => onChange({ ...node, text: [...node.text, 'Text'] })}
          >
            {node.text.length >= SECTION_TEXT_MAX
              ? `Limit of ${SECTION_TEXT_MAX} blocks of text reached`
              : 'Add text to this section'}
          </button>

          <label className="filter">
            <span>Beside the text</span>
            <select
              value={node.accessory.kind}
              onChange={(e) =>
                onChange({
                  ...node,
                  accessory:
                    e.target.value === 'button'
                      ? { kind: 'button', button: blankButton(taken) }
                      : { kind: 'thumbnail', url: '' },
                })
              }
            >
              <option value="thumbnail">A picture</option>
              <option value="button">A button</option>
            </select>
          </label>

          {node.accessory.kind === 'thumbnail' ? (
            <fieldset className="builder-group">
              <legend>Picture beside the text</legend>
              <MediaFields
                item={{
                  url: node.accessory.url,
                  description: node.accessory.description,
                  spoiler: node.accessory.spoiler,
                }}
                path={`${path}.accessory`}
                invalid={invalid}
                onChange={(item) =>
                  onChange({ ...node, accessory: { kind: 'thumbnail', ...item } })
                }
              />
            </fieldset>
          ) : (
            <ButtonEditor
              button={node.accessory.button}
              index={0}
              count={1}
              name="the accessory button"
              title="Accessory"
              legend="What the accessory button does"
              path={`${path}.accessory.button`}
              invalid={invalid}
              roles={roles}
              onChange={(button) => onChange({ ...node, accessory: { kind: 'button', button } })}
              onMove={() => undefined}
              onRemove={() => undefined}
            />
          )}
        </>
      );

    case 'row':
      return (
        <RowEditor
          row={node.row}
          index={index}
          path={`${path}.row`}
          invalid={invalid}
          roles={roles}
          taken={taken}
          onChange={(row) => onChange({ ...node, row })}
        />
      );

    case 'container':
      return (
        <>
          <p className="field-description">
            A framed block with a coloured edge. Containers hold everything else but never another
            container.
          </p>

          <ColorInput
            color={node.accentColor}
            onChange={(accentColor) => onChange({ ...node, accentColor })}
          />

          <SwitchField
            label="Hidden until someone clicks it"
            checked={node.spoiler === true}
            onChange={(spoiler) => onChange({ ...node, spoiler })}
          />

          <V2Nodes
            nodes={node.children}
            label="Child"
            kinds={CHILD_KINDS}
            path={`${path}.children`}
            frame="builder-row"
            empty="This container is empty, and Discord refuses an empty container."
            invalid={invalid}
            roles={roles}
            taken={taken}
            onChange={(children) => onChange({ ...node, children: children.filter(isChild) })}
          />
        </>
      );
  }
}

interface V2NodesProps {
  nodes: readonly V2Component[];
  label: string;
  kinds: readonly V2Kind[];
  path: string;
  frame: string;
  empty: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  taken: ReadonlySet<string>;
  onChange: (nodes: V2Component[]) => void;
}

function V2Nodes({
  nodes,
  label,
  kinds,
  path,
  frame,
  empty,
  invalid,
  roles,
  taken,
  onChange,
}: V2NodesProps): ReactElement {
  return (
    <>
      {nodes.map((node, index) => (
        <div
          className={frame}
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks carry no id, and their keys are edited
          key={`node-${index}`}
        >
          <span className="builder-head">
            <span className="builder-head-title">
              {label} {index + 1}
            </span>
            <span className="pill">{V2_KIND_LABELS[node.kind]}</span>
            <OrderActions
              label={`${lowerFirst(label)} ${index + 1}`}
              index={index}
              count={nodes.length}
              onMove={(to) => onChange(moved(nodes, index, to))}
              onRemove={() => onChange(removed(nodes, index))}
            />
          </span>

          <NodeBody
            node={node}
            index={index}
            path={`${path}.${index}`}
            invalid={invalid}
            roles={roles}
            taken={taken}
            onChange={(next) => onChange(replaced(nodes, index, next))}
          />
        </div>
      ))}

      {nodes.length === 0 ? <p className="field-empty">{empty}</p> : null}

      <label className="filter builder-v2-add">
        <span>Add a block</span>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value === '') return;
            onChange([...nodes, blankNode(e.target.value as V2Kind, taken)]);
          }}
        >
          <option value="">Choose a block…</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {V2_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function Superseded(): ReactElement {
  return (
    <p className="builder-superseded">
      The layout is the whole message. Nothing in this section is sent, and Discord refuses the
      message outright if anything is left here.
    </p>
  );
}

export function MessageBuilder({
  message,
  onChange,
  roles,
  palette = [],
}: MessageBuilderProps): ReactElement {
  const parsed = messageSchema.safeParse(message);

  const failed = new Set(
    parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
  );
  const invalid: InvalidAt = (path) => failed.has(path);

  const embeds = message.embeds;
  const total = embedsLength(embeds);

  const layout = message.v2;
  const laidOut = layout.length > 0;
  const used = countV2Components(layout);

  function setMentions(patch: Partial<MentionPolicy>): void {
    onChange({ ...message, mentions: { ...message.mentions, ...patch } });
  }

  function setLaidOut(next: boolean): void {
    if (!next) {
      onChange({ ...message, v2: [] });
      return;
    }

    const text = message.content?.trim() ?? '';
    const carried: V2Component[] = [
      ...(text === '' ? [] : [{ kind: 'text' as const, content: text }]),
      ...message.components.map((row) => ({ kind: 'row' as const, row })),
    ];

    onChange({
      ...message,
      content: undefined,
      components: [],
      v2: carried.length > 0 ? carried : [{ kind: 'text', content: 'Text' }],
    });
  }

  return (
    <div className="ladder builder" data-path="message">
      <fieldset className="builder-section">
        <legend>Layout</legend>
        <p className="field-description">
          Discord accepts either a classic message — text, embeds and button rows — or a Components
          V2 layout built from the blocks below. Never both.
        </p>

        <p className="builder-v2-note">
          <Icon name="warning" /> Discord never takes the Components V2 flag back off a message.
          Once a message has been posted as a layout, editing it later can only change the layout —
          it can never go back to text and embeds. Post a new message instead.
        </p>

        <SwitchField
          label="Build this message as a layout"
          description="Switching on moves the message text and any button rows into the layout. Switching off clears the layout and the message goes back to text, embeds and button rows."
          checked={laidOut}
          onChange={setLaidOut}
        />

        {laidOut ? (
          <>
            <p className="field-description">
              This layout comes to{' '}
              <span
                className="builder-count"
                data-over={used > V2_COMPONENTS_MAX ? 'true' : undefined}
              >
                {used}/{V2_COMPONENTS_MAX}
              </span>{' '}
              components. Discord counts every block in the tree, containers, section text and
              buttons included.
            </p>

            <V2Nodes
              nodes={layout}
              label="Layout"
              kinds={TOP_KINDS}
              path="v2"
              frame="ladder-rung ladder-rung-stacked builder-rung"
              empty="This layout is empty. Add a block, or switch the layout off."
              invalid={invalid}
              roles={roles}
              taken={layoutKeys(layout)}
              onChange={(v2) => onChange({ ...message, v2 })}
            />
          </>
        ) : embeds.length > 0 ? (
          <p className="field-description">
            An embed cannot move into a layout — Discord has no embed inside one. Remove the{' '}
            {embeds.length === 1 ? 'embed' : 'embeds'} below first, or the message will not save.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="builder-section">
        <legend>Text</legend>
        {laidOut ? <Superseded /> : null}
        <CounterInput
          label="Message text"
          multiline
          rows={4}
          value={message.content ?? ''}
          max={MESSAGE_CONTENT_MAX}
          invalid={invalid('content')}
          onChange={(value) => onChange({ ...message, content: blank(value) })}
        />
      </fieldset>

      <fieldset className="builder-section">
        <legend>Mentions</legend>
        <p className="field-description">
          What this message is allowed to ping. Anything switched off here is still written out as
          text — it just does not notify anyone.
        </p>
        <SwitchField
          label="Allow @everyone and @here"
          description="Notifies every member who can read the channel. Leave this off unless the message is meant to interrupt the whole server."
          checked={message.mentions.everyone}
          onChange={(everyone) => setMentions({ everyone })}
        />
        <SwitchField
          label="Allow role mentions"
          checked={message.mentions.roles}
          onChange={(roles_) => setMentions({ roles: roles_ })}
        />
        <SwitchField
          label="Allow member mentions"
          checked={message.mentions.users}
          onChange={(users) => setMentions({ users })}
        />
      </fieldset>

      <fieldset className="builder-section">
        <legend>Embeds</legend>
        {laidOut ? <Superseded /> : null}
        <p className="field-description">
          Every embed on this message shares one budget of{' '}
          <span className="builder-count" data-over={total > EMBED_TOTAL_MAX ? 'true' : undefined}>
            {total}/{EMBED_TOTAL_MAX}
          </span>{' '}
          characters, counted across titles, descriptions, field names, field text, footers and
          author names.
        </p>

        {embeds.map((embed, index) => (
          <EmbedEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: embeds carry no id of their own
            key={`embed-${index}`}
            embed={embed}
            index={index}
            count={embeds.length}
            path={`embeds.${index}`}
            invalid={invalid}
            onChange={(next) => onChange({ ...message, embeds: replaced(embeds, index, next) })}
            onMove={(to) => onChange({ ...message, embeds: moved(embeds, index, to) })}
            onRemove={() => onChange({ ...message, embeds: removed(embeds, index) })}
          />
        ))}

        {embeds.length === 0 ? (
          <p className="field-empty">No embeds. The message is posted as plain text.</p>
        ) : null}

        <button
          type="button"
          className="button button-quiet"
          disabled={embeds.length >= EMBEDS_PER_MESSAGE_MAX}
          onClick={() => onChange({ ...message, embeds: [...embeds, { description: '' }] })}
        >
          {embeds.length >= EMBEDS_PER_MESSAGE_MAX
            ? `Limit of ${EMBEDS_PER_MESSAGE_MAX} embeds reached`
            : 'Add embed'}
        </button>
      </fieldset>

      <fieldset className="builder-section">
        <legend>Buttons and dropdowns</legend>
        {laidOut ? <Superseded /> : null}
        <ComponentsEditor
          rows={message.components}
          invalid={invalid}
          roles={roles}
          palette={palette}
          onChange={(components) => onChange({ ...message, components })}
        />
      </fieldset>

      {parsed.success ? null : (
        <ul className="ladder-errors" role="alert">
          {parsed.error.issues.map((issue) => (
            <li key={`${issue.path.map(String).join('.')}-${issue.message}`}>
              {describePath(issue.path)}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
