import type { ActionRow, ComponentAction, MentionPolicy, MessageButton } from '@proton/core';
import { DEFAULT_MENTION_POLICY } from '@proton/core';
import {
  type ChannelFacts,
  type PlaceholderSurface,
  SAMPLE_NOW,
  type SurfaceDiagnostic,
  type SurfaceSample,
  usedKeys,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import type {
  SavedComponent,
  SavedMessage,
  TemplateSchedule,
} from '@proton/module-messages/config';
import {
  MESSAGES_POST_SURFACE,
  MESSAGES_REPLY_SURFACE,
  MESSAGES_SCHEDULED_SURFACE,
  type MessagesPlaceholderFacts,
  messagesTemplateNotes,
  messagesTemplates,
  renderReply,
} from '@proton/module-messages/placeholders';
import { useRef } from 'react';
import {
  type MentionNames,
  previewMessage,
  sampleMentionNames,
} from '../../lib/placeholder-preview.ts';

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

// Renaming changes the URL's name on every keystroke; a plain lookup would close the editor mid-word.
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
    placeholders: false,
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

type MessagesSurface = PlaceholderSurface<MessagesPlaceholderFacts>;

export function templateSurface(template: SavedMessage): MessagesSurface {
  return template.schedule === undefined ? MESSAGES_POST_SURFACE : MESSAGES_SCHEDULED_SURFACE;
}

function sampleOf(surface: MessagesSurface): SurfaceSample<MessagesPlaceholderFacts> {
  const [sample] = surface.samples;
  if (sample === undefined) {
    throw new Error(
      `The ${surface.label} placeholders have no sample, so the preview cannot be filled in.`,
    );
  }
  return sample;
}

export interface TemplateChecks {
  at: (path: string) => readonly SurfaceDiagnostic[];
  blocksUnder: (path: string) => boolean;
  elsewhere: SurfaceDiagnostic[];
}

const NO_DIAGNOSTICS: readonly SurfaceDiagnostic[] = [];

const NO_CHECKS: TemplateChecks = {
  at: () => NO_DIAGNOSTICS,
  blocksUnder: () => false,
  elsewhere: [],
};

const EDITED_HERE = [
  'content',
  'embeds.0.title',
  'embeds.0.description',
  'embeds.0.footer.text',
  'embeds.0.imageUrl',
  'embeds.0.thumbnailUrl',
  'embeds.0.fields.*.name',
  'embeds.0.fields.*.value',
  'components.*.buttons.*.label',
  'components.*.buttons.*.url',
  'components.*.buttons.*.action.content',
  'components.*.select.placeholder',
  'components.*.select.options.*.label',
  'components.*.select.options.*.description',
  'components.*.select.options.*.action.content',
].map((pattern) => pattern.split('.'));

function matchesPattern(pattern: readonly string[], segments: readonly string[]): boolean {
  return (
    pattern.length === segments.length &&
    pattern.every((part, at) =>
      part === '*' ? /^\d+$/.test(segments[at] ?? '') : part === segments[at],
    )
  );
}

function onlyTemplate(config: unknown, index: number): { templates: unknown[] } {
  if (typeof config !== 'object' || config === null || !('templates' in config)) {
    return { templates: [] };
  }

  const { templates } = config;
  if (!Array.isArray(templates)) return { templates: [] };

  const items: unknown[] = templates;
  return { templates: items.map((template, at) => (at === index ? template : undefined)) };
}

function placeName(path: string, segments: readonly string[]): string {
  const label =
    MESSAGES_POST_SURFACE.fieldAt(path)?.label ??
    MESSAGES_REPLY_SURFACE.fieldAt(path)?.label ??
    'Message';

  if (segments[0] === 'v2') return `Layout ${label.toLowerCase()}`;
  if (segments[0] === 'embeds') {
    return `Embed ${Number(segments[1]) + 1} ${label.replace(/^Embed /, '')}`;
  }
  return label;
}

export function templateChecks(
  template: SavedMessage,
  index: number,
  config: unknown,
  before: unknown,
): TemplateChecks {
  if (template.placeholders !== true) return NO_CHECKS;

  const next = onlyTemplate(config, index);
  const report = validateConfigTemplates(messagesTemplates, next, onlyTemplate(before, index));
  const byPath = new Map<string, readonly SurfaceDiagnostic[]>(report.byPath);

  for (const { path, diagnostic } of messagesTemplateNotes(next)) {
    byPath.set(path, [...(byPath.get(path) ?? []), diagnostic]);
  }

  const base = `templates.${index}.`;
  const layout = template.v2.length > 0;

  const elsewhere = [...byPath].flatMap(([path, diagnostics]) => {
    const segments = path.slice(base.length).split('.');
    if (!layout && EDITED_HERE.some((pattern) => matchesPattern(pattern, segments))) return [];

    const where = placeName(path, segments);
    return diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: `${where}: ${diagnostic.message}`,
    }));
  });

  return {
    at: (path) => byPath.get(path) ?? NO_DIAGNOSTICS,
    blocksUnder: (path) =>
      report.blocking.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`)),
    elsewhere,
  };
}

export interface PreviewNote {
  label: string | undefined;
  message: string;
}

export interface TemplatePreview {
  message: SavedMessage;
  caption: string | undefined;
  channelName: string | undefined;
  refused: boolean;
  notes: PreviewNote[];
  mentionNames: MentionNames | undefined;
  now: number | undefined;
}

const PREVIEW_NOTE_CODES: ReadonlySet<string> = new Set(['output_truncated', 'invalid_url']);

export function templatePreview(
  template: SavedMessage,
  index: number,
  channel: ChannelFacts | undefined,
): TemplatePreview {
  if (template.placeholders !== true) {
    return {
      message: template,
      caption: undefined,
      channelName: channel?.name,
      refused: false,
      notes: [],
      mentionNames: undefined,
      now: undefined,
    };
  }

  const surface = templateSurface(template);
  const sample = sampleOf(surface);
  const sampleName = sample.facts.destinationChannel?.name;
  const realName = channel?.name;

  const preview = previewMessage(
    surface,
    template,
    sample,
    channel === undefined
      ? undefined
      : {
          destinationChannel: {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            parentId: channel.parentId,
          },
        },
  );

  const notes = new Map<string, PreviewNote>();
  for (const { code, message, path } of preview.diagnostics) {
    if (!PREVIEW_NOTE_CODES.has(code)) continue;

    const label = surface.fieldAt(`templates.${index}.${path}`)?.label;
    notes.set(`${label ?? ''}|${message}`, { label, message });
  }

  return {
    message: preview.message,
    caption:
      realName === undefined || sampleName === undefined
        ? preview.caption
        : preview.caption.replace(`#${sampleName}`, `#${realName}`),
    channelName: realName ?? sampleName,
    refused: preview.problem !== undefined,
    notes: [...notes.values()],
    mentionNames: preview.mentionNames,
    now: preview.now,
  };
}

export interface ReplyPreview {
  text: string;
  caption: string;
  notes: string[];
  mentionNames: MentionNames;
  now: number;
}

export function replyPreview(text: string): ReplyPreview {
  const sample = sampleOf(MESSAGES_REPLY_SURFACE);
  const lookup = MESSAGES_REPLY_SURFACE.build(sample.facts, {
    now: SAMPLE_NOW,
    keys: usedKeys(MESSAGES_REPLY_SURFACE, [text]),
  });

  const notes: string[] = [];
  const rendered = renderReply(text, lookup, SAMPLE_NOW, (_code, message) => {
    notes.push(message);
  });

  return {
    text: rendered,
    caption: sample.label,
    notes,
    mentionNames: sampleMentionNames(MESSAGES_REPLY_SURFACE, lookup, [text]),
    now: SAMPLE_NOW,
  };
}
