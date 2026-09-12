import type {
  ActionRow,
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
import { type CSSProperties, type ReactElement, useId, useState } from 'react';
import { EmojiInput } from '../emoji/picker.tsx';
import {
  type DiscordChannel,
  type DiscordRole,
  roleOptions,
  SinglePicker,
} from '../form/picker.tsx';
import { ConfirmDialog } from '../shell/confirm.tsx';
import { Icon } from '../shell/icon.tsx';
import { ButtonFace } from './button-face.tsx';

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

  // 'embeds' hides the mode picker and the plain button rows. Verification's panel uses it: Proton
  // attaches the verify button as the message's one row, and Discord will not put a row on a
  // components-v2 layout.
  allow?: 'both' | 'embeds';
}

type InvalidAt = (path: string) => boolean;

const ROLE_MODE_LABELS: Record<RoleActionMode, string> = {
  toggle: 'Toggle — press to get the role, press again to lose it',
  add: 'Add only — the role is never taken back',
  remove: 'Remove only',
};

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

// What the block's own header says it is. The long labels above are for the "add a block" menu,
// where the reader is choosing between them and needs the whole phrase.
const V2_KIND_SHORT: Record<V2Kind, string> = {
  text: 'Text',
  separator: 'Separator',
  gallery: 'Pictures',
  section: 'Section',
  row: 'Buttons',
  container: 'Container',
};

const SUMMARY_MAX = 44;

function clamp(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();

  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/**
 * What the block holds, printed beside its kind. A collapsed tree of blocks all called "Text" is a
 * tree you have to open one at a time to find anything in.
 */
function summaryOf(node: V2Component): string {
  switch (node.kind) {
    case 'text':
      return clamp(node.content);
    case 'separator':
      return node.divider
        ? `Line, ${SPACING_LABELS[node.spacing].toLowerCase()} gap`
        : `${SPACING_LABELS[node.spacing]} gap`;
    case 'gallery':
      return `${node.items.length} picture${node.items.length === 1 ? '' : 's'}`;
    case 'section':
      return clamp(node.text.join(' '));
    case 'row':
      return node.row.kind === 'select'
        ? clamp(node.row.select.placeholder ?? 'Dropdown')
        : clamp(
            node.row.buttons
              .map((button) => button.label ?? formatComponentEmoji(button.emoji))
              .filter((label) => label !== '')
              .join(', '),
          );
    case 'container':
      return node.children.map((child) => V2_KIND_SHORT[child.kind]).join(', ');
  }
}

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
      <span className="builder-count" aria-hidden="true" data-over={over ? 'true' : undefined}>
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

/**
 * A `.filter` row like LineInput, but the control is the picker. The `<label>` becomes a `<div>`
 * because a label wrapping a button is a label with no form control to name — the trigger carries
 * its own accessible name instead.
 */
function EmojiField({
  label,
  value,
  onChange,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}): ReactElement {
  return (
    <div className="filter">
      <span>{label}</span>
      <EmojiInput value={value} onChange={onChange} invalid={invalid} name={label} />
    </div>
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

      <ButtonFace
        label={button.label ?? ''}
        emoji={formatComponentEmoji(button.emoji)}
        style={button.style}
        max={BUTTON_LABEL_MAX}
        disabled={button.disabled === true}
        labelInvalid={invalid(`${path}.label`)}
        emojiInvalid={invalid(`${path}.emoji`)}
        onLabel={(value) => onChange({ ...button, label: blank(value) })}
        onEmoji={(value) => onChange({ ...button, emoji: parseComponentEmoji(value) })}
        // A link button carries a URL and no action; every other style carries an action and no
        // URL, so picking one has to drop the half that no longer applies or the save is refused.
        onStyle={(style) =>
          onChange(
            style === 'link'
              ? { ...button, style, action: undefined }
              : { ...button, style, url: undefined },
          )
        }
      />

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

      <EmojiField
        label="Emoji"
        value={formatComponentEmoji(option.emoji)}
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

  const accent =
    embed.color === undefined ? undefined : `#${embed.color.toString(16).padStart(6, '0')}`;

  return (
    // Shaped like the embed it makes: the accent down the left edge, the author over the title over
    // the description, the fields, then the footer. The old form was the same values as fourteen
    // labelled rows in schema order, which told you nothing about what you were building.
    <div
      className="embed-card"
      data-path={path}
      style={accent === undefined ? undefined : ({ '--embed-accent': accent } as CSSProperties)}
    >
      <div className="embed-card-head">
        <span className="embed-card-title">Embed {index + 1}</span>
        <span className="embed-card-summary">{clamp(embed.title ?? embed.description ?? '')}</span>
        <ColorInput color={embed.color} onChange={(color) => patch({ color })} />
        <OrderActions
          label={`embed ${index + 1}`}
          index={index}
          count={count}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>

      <div className="embed-card-body">
        <div className="embed-line embed-line-author">
          <Avatar url={author?.iconUrl} />
          <FaceInput
            label="Author name"
            placeholder="Author"
            value={author?.name ?? ''}
            max={EMBED_AUTHOR_NAME_MAX}
            invalid={invalid(`${path}.author.name`)}
            onChange={(value) => setAuthor(value, author?.url, author?.iconUrl)}
          />
        </div>

        <FaceInput
          label="Title"
          placeholder="Title"
          className="embed-title"
          value={embed.title ?? ''}
          max={EMBED_TITLE_MAX}
          invalid={invalid(`${path}.title`)}
          onChange={(value) => patch({ title: blank(value) })}
        />

        <FaceInput
          label="Description"
          placeholder="Description"
          className="embed-description"
          multiline
          rows={5}
          value={embed.description ?? ''}
          max={EMBED_DESCRIPTION_MAX}
          invalid={invalid(`${path}.description`)}
          onChange={(value) => patch({ description: blank(value) })}
        />

        <EmbedFieldsEditor
          fields={embed.fields ?? []}
          embedIndex={index}
          path={`${path}.fields`}
          invalid={invalid}
          onChange={(fields) => patch({ fields })}
        />

        <Picture
          label="Image"
          url={embed.imageUrl}
          invalid={invalid(`${path}.imageUrl`)}
          onChange={(value) => patch({ imageUrl: value })}
        />

        <div className="embed-line embed-line-footer">
          <Avatar url={footer?.iconUrl} small />
          <FaceInput
            label="Footer text"
            placeholder="Footer"
            value={footer?.text ?? ''}
            max={EMBED_FOOTER_TEXT_MAX}
            invalid={invalid(`${path}.footer.text`)}
            onChange={(value) => setFooter(value, footer?.iconUrl)}
          />
        </div>
      </div>

      {/* The links, the small pictures and the timestamp. Every embed has a title and a body; most
          have none of these, and in schema order they sat between the two things that are always
          filled in. */}
      <details className="embed-more">
        <summary>Links, icons and timestamp</summary>

        <div className="embed-more-body">
          <LineInput
            label="Title links to"
            value={embed.url ?? ''}
            placeholder="https://example.com"
            invalid={invalid(`${path}.url`)}
            onChange={(value) => patch({ url: blank(value) })}
          />
          <LineInput
            label="Author links to"
            value={author?.url ?? ''}
            placeholder="https://example.com"
            invalid={invalid(`${path}.author.url`)}
            onChange={(value) => setAuthor(author?.name ?? '', blank(value), author?.iconUrl)}
          />
          <LineInput
            label="Author icon"
            value={author?.iconUrl ?? ''}
            placeholder="https://example.com/avatar.png"
            invalid={invalid(`${path}.author.iconUrl`)}
            onChange={(value) => setAuthor(author?.name ?? '', author?.url, blank(value))}
          />
          <LineInput
            label="Footer icon"
            value={footer?.iconUrl ?? ''}
            placeholder="https://example.com/icon.png"
            invalid={invalid(`${path}.footer.iconUrl`)}
            onChange={(value) => setFooter(footer?.text ?? '', blank(value))}
          />
          <LineInput
            label="Thumbnail"
            value={embed.thumbnailUrl ?? ''}
            placeholder="https://example.com/thumb.png"
            invalid={invalid(`${path}.thumbnailUrl`)}
            onChange={(value) => patch({ thumbnailUrl: blank(value) })}
          />

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
        </div>
      </details>
    </div>
  );
}

function Avatar({ url, small }: { url?: string | undefined; small?: boolean }): ReactElement {
  return (
    <span className={`embed-avatar${small ? ' embed-avatar-sm' : ''}`} aria-hidden="true">
      {url ? <img src={url} alt="" /> : <Icon name="user-circle" />}
    </span>
  );
}

/**
 * The placeholder is the label. That is normally forbidden — a placeholder disappears the moment
 * anything is typed — so the real label is still there for a screen reader, just not drawn: on this
 * one surface the point is that the form looks like the embed, and a column of labels down the left
 * is what stopped it doing that.
 */
function FaceInput({
  label,
  placeholder,
  value,
  max,
  className,
  multiline,
  rows,
  invalid,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  max: number;
  className?: string;
  multiline?: boolean;
  rows?: number;
  invalid: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  const over = value.length > max;

  return (
    <span className={`embed-face${className ? ` ${className}` : ''}`}>
      {multiline ? (
        <textarea
          rows={rows ?? 3}
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={invalid || over}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={invalid || over}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {/* Only once something is typed. An empty embed drawn with six 0/256 counters reads as a form
          with six problems in it. */}
      {value === '' ? null : (
        <span className="embed-face-count num" data-over={over || undefined}>
          {value.length}/{max}
        </span>
      )}
    </span>
  );
}

function Picture({
  label,
  url,
  invalid,
  onChange,
}: {
  label: string;
  url: string | undefined;
  invalid: boolean;
  onChange: (value: string | undefined) => void;
}): ReactElement {
  return (
    <div className="embed-picture" data-filled={url ? 'true' : undefined}>
      {url ? (
        <img className="embed-picture-preview" src={url} alt="" />
      ) : (
        <Icon name="image" className="embed-picture-mark" />
      )}

      <input
        type="text"
        value={url ?? ''}
        placeholder={`${label} URL`}
        aria-label={label}
        aria-invalid={invalid}
        onChange={(event) => onChange(blank(event.target.value))}
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
            Up to {SECTION_TEXT_MAX} blocks of text, with one thing beside them all. A section
            without one will not save.
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
            empty="This container is empty. Put something in it, or remove it."
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
  // Per list, so a drag started in a nested list is invisible to the one around it: the outer
  // blocks see the same bubbled dragover, and bail because their own drag never started.
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  function drop(to: number): void {
    if (dragging !== null) onChange(moved(nodes, dragging, to));

    setDragging(null);
    setOver(null);
  }

  return (
    <>
      {nodes.map((node, index) => (
        <Block
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks carry no id, and their keys are edited
          key={`node-${index}`}
          node={node}
          index={index}
          count={nodes.length}
          label={label}
          frame={frame}
          path={`${path}.${index}`}
          invalid={invalid}
          roles={roles}
          taken={taken}
          dragging={dragging === index}
          over={over === index && dragging !== null && dragging !== index}
          onGrab={() => setDragging(index)}
          onDrag={() => (dragging === null ? undefined : setOver(index))}
          onDrop={() => drop(index)}
          onRelease={() => {
            setDragging(null);
            setOver(null);
          }}
          onMove={(to) => onChange(moved(nodes, index, to))}
          onRemove={() => onChange(removed(nodes, index))}
          onDuplicate={() =>
            onChange([...nodes.slice(0, index + 1), copyOf(node, taken), ...nodes.slice(index + 1)])
          }
          onChange={(next) => onChange(replaced(nodes, index, next))}
        />
      ))}

      {nodes.length === 0 ? <p className="field-empty">{empty}</p> : null}

      <AddBlock
        kinds={kinds}
        inside={label !== 'Layout'}
        onAdd={(kind) => onChange([...nodes, blankNode(kind, taken)])}
      />
    </>
  );
}

/**
 * A duplicate has to claim its own button and option keys, or the copy and the original answer to
 * the same custom id and Discord routes every press to whichever the worker registered last.
 */
function copyOf(node: V2Component, taken: ReadonlySet<string>): V2Component {
  if (node.kind === 'row') return { kind: 'row', row: withFreshKeys(node.row, taken) };

  if (node.kind === 'section' && node.accessory.kind === 'button') {
    const row = withFreshKeys({ kind: 'buttons', buttons: [node.accessory.button] }, taken);
    const button = row.kind === 'buttons' ? row.buttons[0] : undefined;

    return button ? { ...node, accessory: { kind: 'button', button } } : structuredClone(node);
  }

  if (node.kind === 'container') {
    const claimed = new Set(taken);
    const children = node.children.map((child) => {
      const copy = copyOf(child, claimed);
      for (const key of layoutKeys([copy])) claimed.add(key);

      return copy as ContainerChild;
    });

    return { ...node, children };
  }

  return structuredClone(node);
}

function AddBlock({
  kinds,
  inside,
  onAdd,
}: {
  kinds: readonly V2Kind[];
  inside: boolean;
  onAdd: (kind: V2Kind) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div className="builder-add">
      <button type="button" className="builder-add-trigger" onClick={() => setOpen((was) => !was)}>
        <Icon name={open ? 'x' : 'plus'} />
        {inside ? 'Add block inside' : 'Add block'}
      </button>

      {open ? (
        <div className="builder-add-menu">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              className="builder-add-option"
              onClick={() => {
                onAdd(kind);
                setOpen(false);
              }}
            >
              {V2_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface BlockProps {
  node: V2Component;
  index: number;
  count: number;
  label: string;
  frame: string;
  path: string;
  invalid: InvalidAt;
  roles: readonly DiscordRole[];
  taken: ReadonlySet<string>;

  dragging: boolean;
  over: boolean;
  onGrab: () => void;
  onDrag: () => void;
  onDrop: () => void;
  onRelease: () => void;

  onMove: (to: number) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onChange: (node: V2Component) => void;
}

function Block({
  node,
  index,
  count,
  label,
  frame,
  path,
  invalid,
  roles,
  taken,
  dragging,
  over,
  onGrab,
  onDrag,
  onDrop,
  onRelease,
  onMove,
  onRemove,
  onDuplicate,
  onChange,
}: BlockProps): ReactElement {
  const [open, setOpen] = useState(true);
  const bodyId = useId();

  const named = `${lowerFirst(label)} ${index + 1}`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop target is the block; the grip is what drags, and the arrow buttons are the keyboard path
    <div
      className={frame}
      data-dragging={dragging || undefined}
      data-over={over || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        onDrag();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <div className="builder-block-head">
        {/* Draggable itself rather than the whole block: a draggable container swallows the text
            selection in every input inside it. */}
        <span
          className="builder-block-grip"
          draggable
          title="Drag to reorder"
          aria-hidden="true"
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';

            const block = event.currentTarget.closest('.builder-block');
            if (block instanceof HTMLElement) event.dataTransfer.setDragImage(block, 16, 16);

            onGrab();
          }}
          onDragEnd={onRelease}
        >
          <Icon name="dots-six-vertical" />
        </span>

        <button
          type="button"
          className="builder-block-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${V2_KIND_SHORT[node.kind]}, ${named}`}
          onClick={() => setOpen((was) => !was)}
        >
          <Icon name={open ? 'caret-down' : 'caret-right'} />
          <span className="builder-block-kind">{V2_KIND_SHORT[node.kind]}</span>
          <span className="builder-block-summary">{summaryOf(node)}</span>
        </button>

        <span className="builder-block-actions">
          <button
            type="button"
            className="button button-ghost"
            aria-label={`Duplicate ${named}`}
            onClick={onDuplicate}
          >
            <Icon name="copy" />
          </button>
          <OrderActions
            label={named}
            index={index}
            count={count}
            onMove={onMove}
            onRemove={onRemove}
          />
        </span>
      </div>

      <div className="builder-block-body" id={bodyId} hidden={!open}>
        <NodeBody
          node={node}
          index={index}
          path={path}
          invalid={invalid}
          roles={roles}
          taken={taken}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

/**
 * The two shapes a Discord message can take, as a choice rather than a switch. They are mutually
 * exclusive in the schema — `refineMessage` refuses a layout that also carries text, an embed or a
 * plain row — so the old toggle left half the builder on screen, greyed out and unusable, with a
 * note under each dead section explaining why. The picker swaps the workspace instead.
 */
function ModePicker({
  laidOut,
  onPick,
}: {
  laidOut: boolean;
  onPick: (laidOut: boolean) => void;
}): ReactElement {
  const name = useId();

  return (
    <fieldset className="builder-mode">
      <legend className="sr-only">How this message is built</legend>

      <div className="mode-cards">
        <label className="mode-card" data-current={laidOut ? undefined : 'true'}>
          <input type="radio" name={name} checked={!laidOut} onChange={() => onPick(false)} />
          <span className="mode-card-art mode-card-art-embeds" aria-hidden="true" />
          <span className="mode-card-text">
            <span className="mode-card-name">Embeds</span>
            <span className="mode-card-blurb">Coloured panels with text and fields.</span>
          </span>
        </label>

        <label className="mode-card" data-current={laidOut ? 'true' : undefined}>
          <input type="radio" name={name} checked={laidOut} onChange={() => onPick(true)} />
          <span className="mode-card-art mode-card-art-components" aria-hidden="true" />
          <span className="mode-card-text">
            <span className="mode-card-name">Components</span>
            <span className="mode-card-blurb">Text, images and buttons in any order.</span>
          </span>
        </label>
      </div>
    </fieldset>
  );
}

export function MessageBuilder({
  message,
  onChange,
  roles,
  palette = [],
  allow = 'both',
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

  const [discarding, setDiscarding] = useState(false);

  function setMentions(patch: Partial<MentionPolicy>): void {
    onChange({ ...message, mentions: { ...message.mentions, ...patch } });
  }

  // Picking Embeds throws the whole layout away, and the picker is one click. Anything already
  // built asks first; an empty layout switches straight back, because there is nothing to lose.
  function askToPick(next: boolean): void {
    if (!next && layout.length > 0) {
      setDiscarding(true);
      return;
    }

    setLaidOut(next);
  }

  function setLaidOut(next: boolean): void {
    setDiscarding(false);

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
      {allow === 'both' ? <ModePicker laidOut={laidOut} onPick={askToPick} /> : null}

      {laidOut ? (
        <p className="builder-v2-note">
          <Icon name="warning" /> Once a message has been posted as components it stays that way.
          Editing it later can only change the components — it can never go back to embeds. Post a
          new message instead.
        </p>
      ) : null}

      {laidOut ? (
        <fieldset className="builder-section">
          <legend>Components</legend>
          <p className="field-description">
            This layout comes to{' '}
            <span
              className="builder-count"
              data-over={used > V2_COMPONENTS_MAX ? 'true' : undefined}
            >
              {used}/{V2_COMPONENTS_MAX}
            </span>{' '}
            components. Discord counts every block in the tree, containers, section text and buttons
            included.
          </p>

          <V2Nodes
            nodes={layout}
            label="Layout"
            kinds={TOP_KINDS}
            path="v2"
            frame="builder-block"
            empty="Nothing here yet. Add a block to start the message."
            invalid={invalid}
            roles={roles}
            taken={layoutKeys(layout)}
            onChange={(v2) => onChange({ ...message, v2 })}
          />
        </fieldset>
      ) : (
        <fieldset className="builder-section">
          <legend>Text</legend>
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
      )}

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

      {laidOut ? null : (
        <fieldset className="builder-section">
          <legend>Embeds</legend>
          <p className="field-description">
            Every embed on this message shares one budget of{' '}
            <span
              className="builder-count"
              data-over={total > EMBED_TOTAL_MAX ? 'true' : undefined}
            >
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
      )}

      {/* Absent under `allow="embeds"`: the surface using it attaches its own row, and Discord
          allows a message one set of components. */}
      {laidOut || allow === 'embeds' ? null : (
        <fieldset className="builder-section">
          <legend>Buttons and dropdowns</legend>
          <ComponentsEditor
            rows={message.components}
            invalid={invalid}
            roles={roles}
            palette={palette}
            onChange={(components) => onChange({ ...message, components })}
          />
        </fieldset>
      )}

      {discarding ? (
        <ConfirmDialog
          title="Switch to embeds and discard this layout?"
          cancelLabel="Keep the components"
          confirmLabel="Discard and switch"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => setLaidOut(false)}
        >
          {used === 1 ? 'The one block' : `All ${used} blocks`} in this layout will be removed. A
          message is either embeds or components, so the two cannot both be kept.
        </ConfirmDialog>
      ) : null}

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
