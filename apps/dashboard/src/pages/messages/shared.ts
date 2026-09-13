import type { ActionRow, ComponentAction, MentionPolicy, MessageButton } from '@proton/core';
import { DEFAULT_MENTION_POLICY } from '@proton/core';
import type {
  SavedComponent,
  SavedMessage,
  TemplateSchedule,
} from '@proton/module-messages/config';
import { useRef } from 'react';

export const BUTTON_STYLE_LABELS: Readonly<Record<string, string>> = {
  primary: 'Blurple',
  secondary: 'Grey',
  success: 'Green',
  danger: 'Red',
  link: 'Link',
};

export const ROLE_MODE_LABELS: Readonly<Record<string, string>> = {
  toggle: 'Toggle',
  add: 'Give',
  remove: 'Remove',
};

export const ROLE_MODE_HELP: Readonly<Record<string, string>> = {
  toggle: 'Give the role, or remove it if the member already has it.',
  add: 'Give the role. Using it again changes nothing.',
  remove: 'Remove the role. Using it again changes nothing.',
};

export const NEEDS_MANAGE_ROLES =
  'Giving or removing a role needs Manage Roles, which the Messages module does not require. ' +
  'Without it, the message still posts but the role does not change.';

export const V2_PRESS_UNROUTABLE =
  'The message still posts, but Proton cannot act on a button or dropdown inside a layout. Use a ' +
  'link button, or move the button out of the layout.';

// The URL holds the name the editor was opened under, and renaming changes that name on every
// keystroke, so a plain lookup would close the editor mid-word.
export function useHeldIndex(id: string | undefined, keys: readonly string[]): number {
  const held = useRef<{ id: string; index: number } | null>(null);
  const found = id === undefined ? -1 : keys.indexOf(id);

  if (id !== undefined && found >= 0) held.current = { id, index: found };
  if (found >= 0) return found;

  const remembered = id !== undefined && held.current?.id === id ? held.current.index : -1;
  return remembered >= 0 && remembered < keys.length ? remembered : -1;
}

export function templateKeys(templates: readonly SavedMessage[]): string[] {
  return templates.map((template) => template.name.trim().toLowerCase());
}

export function componentNameKeys(components: readonly SavedComponent[]): string[] {
  return components.map((component) => component.name.trim().toLowerCase());
}

export function uniqueName(base: string, taken: readonly string[], max: number): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  const trimmed = base.trim().slice(0, max);

  if (!used.has(trimmed.toLowerCase())) return trimmed;

  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${trimmed.slice(0, max - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function freshKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function newButton(taken: ReadonlySet<string>): MessageButton {
  return {
    key: freshKey('button', taken),
    style: 'secondary',
    label: 'Button',
    action: { kind: 'reply', content: '', ephemeral: true },
  };
}

export function newButtonRow(taken: ReadonlySet<string>): ActionRow {
  return { kind: 'buttons', buttons: [newButton(taken)] };
}

export function newSelectRow(taken: ReadonlySet<string>): ActionRow {
  const key = freshKey('menu', taken);

  return {
    kind: 'select',
    select: {
      key,
      placeholder: 'Choose one',
      options: [
        {
          key: freshKey('option', new Set([...taken, key])),
          label: 'Option',
          action: { kind: 'reply', content: '', ephemeral: true },
        },
      ],
    },
  };
}

export const DEFAULT_ACTION: ComponentAction = { kind: 'reply', content: '', ephemeral: true };

export function emptyTemplate(name: string): SavedMessage {
  return {
    name,
    content: '',
    embeds: [],
    components: [],
    mentions: DEFAULT_MENTION_POLICY,
    v2: [],
  };
}

export function emptyComponent(name: string, kind: ActionRow['kind']): SavedComponent {
  return {
    name,
    row: kind === 'select' ? newSelectRow(new Set()) : newButtonRow(new Set()),
  };
}

export function describeRow(row: ActionRow): string {
  return row.kind === 'select'
    ? `Dropdown · ${row.select.options.length} option${row.select.options.length === 1 ? '' : 's'}`
    : `Buttons · ${row.buttons.length}`;
}

export function rowActions(row: ActionRow): ComponentAction[] {
  return row.kind === 'select'
    ? row.select.options.map((option) => option.action)
    : row.buttons.flatMap((button) => (button.action ? [button.action] : []));
}

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  const last = words[words.length - 1] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${last}`;
}

export function mentionCaption(policy: MentionPolicy): string {
  const on: string[] = [];
  if (policy.roles) on.push('roles');
  if (policy.users) on.push('members');
  if (policy.everyone) on.push('@everyone', '@here');

  if (on.length === 0) return 'Mentions still show but do not notify anyone.';

  return policy.roles && policy.users && policy.everyone
    ? `Can ping ${joinWords(on)}.`
    : `Can ping ${joinWords(on)}. Other mentions still show but do not notify anyone.`;
}

export function templateContents(template: SavedMessage): string[] {
  const parts: string[] = [];
  const embeds = template.embeds.length;
  const rows = template.components.length;

  if ((template.content ?? '').trim() !== '') parts.push('Text');
  if (embeds > 0) parts.push(`${embeds} embed${embeds === 1 ? '' : 's'}`);
  if (rows > 0) parts.push(`${rows} row${rows === 1 ? '' : 's'}`);
  if (template.v2.length > 0) parts.push('Layout');

  return parts.length === 0 ? ['Empty'] : parts;
}

export function scheduleSummary(
  schedule: TemplateSchedule | undefined,
  channelName: string | undefined,
): string {
  if (!schedule) return 'Not scheduled';

  const where = channelName === undefined ? 'its channel' : `#${channelName}`;

  return schedule.mode === 'repeat'
    ? `Every ${schedule.every ?? '—'}, from ${schedule.at} in ${where}`
    : `Once, ${schedule.at} in ${where}`;
}

export function startHasPassed(schedule: TemplateSchedule | undefined): boolean {
  if (schedule?.mode !== 'once') return false;

  const at = Date.parse(schedule.at);
  return Number.isFinite(at) && at < Date.now();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function isoWithOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const size = Math.abs(minutes);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(size / 60))}:${pad(size % 60)}`
  );
}
