import {
  type CommandField,
  type CommandIssue,
  type CommandNameEntry,
  type CommandUpdateBody,
  type CommandView,
  codePointLength,
  descriptionIssue,
  nameClash,
  nameIssue,
  type ReplyControl,
  sizeIssue,
} from '@proton/core';

export interface CommandDraft {
  name: string;
  savedName: string | null;
  description: string;
  options: Readonly<Record<string, string>>;
  privateReply: boolean | null;
}

export interface CommandEdits {
  name?: string;
  savedNameCleared?: boolean;
  description?: string;
  options: Readonly<Record<string, string>>;
  privateReply?: boolean | null;
}

export type DraftField = 'name' | 'description' | 'options' | 'privateReply';

export interface DraftIssues {
  name?: string;
  description?: string;
  options: Readonly<Record<string, string>>;
  size?: string;
}

export interface ServerIssues extends DraftIssues {
  other: readonly string[];
}

export type CommandSubmission = Omit<CommandUpdateBody, 'actorId' | 'source' | 'ipHash'>;

export const NO_EDITS: CommandEdits = { options: {} };

export const SIZE_NOTE_FROM = 6000;
export const COUNTER_FROM = 80;

export function flatFields(fields: readonly CommandField[]): CommandField[] {
  return fields.flatMap((field) => [field, ...flatFields(field.children)]);
}

export function nameInput(value: string): string {
  return value.replace(/^\//, '').toLowerCase();
}

export function nameCaret(value: string, caret: number): number {
  return nameInput(value.slice(0, caret)).length;
}

function normalName(value: string): string {
  return nameInput(value.trim()).trim();
}

export function unusedSavedName(command: CommandView): string | null {
  const saved = command.settings.name;
  if (command.kind !== 'chat' || command.refused || saved === null) return null;
  return saved === command.effectiveName ? null : saved;
}

export function baseDraft(command: CommandView): CommandDraft {
  const stored = command.settings.optionDescriptions;
  const options: Record<string, string> = {};

  for (const field of flatFields(command.fields)) {
    options[field.path] = Object.hasOwn(stored, field.path) ? (stored[field.path] ?? '') : '';
  }

  return {
    name: command.refused
      ? (command.settings.name ?? command.effectiveName)
      : command.effectiveName,
    savedName: unusedSavedName(command),
    description: command.settings.description ?? '',
    options,
    privateReply: command.settings.privateReply,
  };
}

export function draftOf(command: CommandView, edits: CommandEdits): CommandDraft {
  const base = baseDraft(command);
  const options: Record<string, string> = { ...base.options };

  for (const path of Object.keys(base.options)) {
    if (Object.hasOwn(edits.options, path)) options[path] = edits.options[path] ?? '';
  }

  return {
    name: edits.name ?? base.name,
    savedName: edits.savedNameCleared === true ? null : base.savedName,
    description: edits.description ?? base.description,
    options,
    privateReply: Object.hasOwn(edits, 'privateReply')
      ? (edits.privateReply ?? null)
      : base.privateReply,
  };
}

export function withName(edits: CommandEdits, name: string): CommandEdits {
  return { ...edits, name };
}

export function withSavedNameCleared(edits: CommandEdits): CommandEdits {
  return { ...edits, savedNameCleared: true };
}

export function withDescription(edits: CommandEdits, description: string): CommandEdits {
  return { ...edits, description };
}

export function withOption(edits: CommandEdits, path: string, value: string): CommandEdits {
  return { ...edits, options: { ...edits.options, [path]: value } };
}

export function withPrivateReply(edits: CommandEdits, privateReply: boolean | null): CommandEdits {
  return { ...edits, privateReply };
}

function effectiveText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

export function draftName(command: CommandView, draft: CommandDraft): string {
  const name = normalName(draft.name);
  return name === '' ? command.name : name;
}

export function changedFields(command: CommandView, edits: CommandEdits): DraftField[] {
  const base = baseDraft(command);
  const draft = draftOf(command, edits);
  const changed: DraftField[] = [];

  if (
    draftName(command, draft) !== draftName(command, base) ||
    draft.savedName !== base.savedName
  ) {
    changed.push('name');
  }
  if (draft.description.trim() !== base.description.trim()) changed.push('description');
  if (
    Object.keys(base.options).some(
      (path) => (draft.options[path] ?? '').trim() !== (base.options[path] ?? '').trim(),
    )
  ) {
    changed.push('options');
  }
  if (draft.privateReply !== base.privateReply) changed.push('privateReply');

  return changed;
}

export function isDirty(command: CommandView, edits: CommandEdits): boolean {
  return changedFields(command, edits).length > 0;
}

export function adoptsFresher(
  shown: CommandView,
  command: CommandView,
  edits: CommandEdits,
): boolean {
  return (
    command.key === shown.key &&
    (command.settings.updatedAt !== shown.settings.updatedAt ||
      command.definitionHash !== shown.definitionHash) &&
    !isDirty(shown, edits)
  );
}

export function defaultEdits(command: CommandView): CommandEdits {
  const options: Record<string, string> = {};
  for (const field of flatFields(command.fields)) options[field.path] = '';

  return {
    name: command.name,
    savedNameCleared: true,
    description: '',
    options,
    privateReply: null,
  };
}

export function atDefaults(command: CommandView, edits: CommandEdits): boolean {
  const draft = draftOf(command, edits);

  return (
    draftName(command, draft) === command.name &&
    draft.savedName === null &&
    effectiveText(draft.description, command.description) === command.description &&
    flatFields(command.fields).every(
      (field) =>
        effectiveText(draft.options[field.path] ?? '', field.description) === field.description,
    ) &&
    draft.privateReply === null
  );
}

// Edits equal to the old start are dropped, or they would overwrite the save that caused the 409.
export function rebaseEdits(
  previous: CommandView,
  next: CommandView,
  edits: CommandEdits,
): CommandEdits {
  const before = baseDraft(previous);
  const paths = new Set(flatFields(next.fields).map((field) => field.path));
  const rebased: CommandEdits = {
    options: Object.fromEntries(
      Object.entries(edits.options).filter(
        ([path, value]) => paths.has(path) && value.trim() !== (before.options[path] ?? '').trim(),
      ),
    ),
  };

  if (
    edits.name !== undefined &&
    draftName(previous, { ...before, name: edits.name }) !== draftName(previous, before)
  ) {
    rebased.name = edits.name;
  }
  if (edits.savedNameCleared === true && unusedSavedName(next) !== null) {
    rebased.savedNameCleared = true;
  }
  if (edits.description !== undefined && edits.description.trim() !== before.description.trim()) {
    rebased.description = edits.description;
  }

  const privateReply = edits.privateReply ?? null;
  if (
    Object.hasOwn(edits, 'privateReply') &&
    privateReply !== before.privateReply &&
    (privateReply === null || next.reply?.supported === true)
  ) {
    rebased.privateReply = privateReply;
  }

  return rebased;
}

function submittedName(command: CommandView, draft: CommandDraft): string | null {
  const base = baseDraft(command);
  const typed = normalName(draft.name);
  const blankable = typed === '' ? null : typed;

  // Null, not Proton's own name: sent the name in effect, the API keeps a saved name it isn't using.
  if (draftName(command, draft) !== draftName(command, base)) {
    return typed === command.name ? null : blankable;
  }
  if (draft.savedName !== base.savedName) return null;
  return command.settings.name ?? blankable;
}

export function submission(command: CommandView, edits: CommandEdits): CommandSubmission {
  const draft = draftOf(command, edits);
  const description = draft.description.trim();
  const optionDescriptions: Record<string, string> = {};

  for (const field of flatFields(command.fields)) {
    const value = (draft.options[field.path] ?? '').trim();
    if (value !== '') optionDescriptions[field.path] = value;
  }

  return {
    name: submittedName(command, draft),
    description: description === '' ? null : description,
    optionDescriptions,
    privateReply: draft.privateReply,
    expectedUpdatedAt: command.settings.updatedAt,
    definitionHash: command.definitionHash,
  };
}

export function nameEntries(commands: readonly CommandView[]): CommandNameEntry[] {
  return commands.map((command) => ({
    key: command.key,
    kind: command.kind,
    defaultName: command.name,
    customName: command.effectiveName === command.name ? null : command.effectiveName,
    updatedAt: command.settings.updatedAt,
  }));
}

export function draftSize(command: CommandView, draft: CommandDraft): number {
  let size =
    command.fixedSize +
    codePointLength(draftName(command, draft)) +
    codePointLength(effectiveText(draft.description, command.description));

  for (const field of flatFields(command.fields)) {
    size += codePointLength(effectiveText(draft.options[field.path] ?? '', field.description));
  }

  return size;
}

export function draftIssues(
  command: CommandView,
  draft: CommandDraft,
  catalogue: readonly CommandView[] = [],
): DraftIssues {
  const issues: DraftIssues = { options: {} };
  const options: Record<string, string> = {};

  const name = normalName(draft.name);
  if (name !== '') {
    const claimed = catalogue.length > 0 && name !== command.settings.name;
    const problem =
      nameIssue(name) ?? (claimed ? nameClash(nameEntries(catalogue), command.key, name) : null);
    if (problem !== null) issues.name = problem;
  }

  const description = descriptionIssue(effectiveText(draft.description, command.description));
  if (description !== null) issues.description = description;

  for (const field of flatFields(command.fields)) {
    const problem = descriptionIssue(
      effectiveText(draft.options[field.path] ?? '', field.description),
    );
    if (problem !== null) options[field.path] = problem;
  }

  const size = sizeIssue(draftSize(command, draft));
  if (size !== null) issues.size = size;

  return { ...issues, options };
}

export function hasIssues(issues: DraftIssues): boolean {
  return (
    issues.name !== undefined ||
    issues.description !== undefined ||
    issues.size !== undefined ||
    Object.keys(issues.options).length > 0
  );
}

export const NO_SERVER_ISSUES: ServerIssues = { options: {}, other: [] };

export function mapServerIssues(
  command: CommandView,
  issues: readonly CommandIssue[],
): ServerIssues {
  const paths = new Set(flatFields(command.fields).map((field) => field.path));
  const mapped: ServerIssues = { options: {}, other: [] };
  const options: Record<string, string> = {};
  const other: string[] = [];

  for (const issue of issues) {
    const option = issue.path.startsWith('options.') ? issue.path.slice('options.'.length) : null;

    if (issue.path === 'name' && mapped.name === undefined) mapped.name = issue.message;
    else if (issue.path === 'description' && mapped.description === undefined) {
      mapped.description = issue.message;
    } else if (issue.path === 'size' && mapped.size === undefined) mapped.size = issue.message;
    else if (option !== null && paths.has(option) && options[option] === undefined) {
      options[option] = issue.message;
    } else other.push(issue.message);
  }

  return { ...mapped, options, other };
}

export type IssueField = 'name' | 'description' | { option: string };

export function withoutServerIssue(issues: ServerIssues, field: IssueField): ServerIssues {
  const options = { ...issues.options };
  if (typeof field === 'object') delete options[field.option];

  const next: ServerIssues = { options, other: issues.other };
  if (field !== 'name' && issues.name !== undefined) next.name = issues.name;
  if (field !== 'description' && issues.description !== undefined) {
    next.description = issues.description;
  }

  return next;
}

export function issueFor(
  live: DraftIssues,
  server: ServerIssues,
  field: IssueField,
): string | undefined {
  if (field === 'name') return live.name ?? server.name;
  if (field === 'description') return live.description ?? server.description;
  return live.options[field.option] ?? server.options[field.option];
}

export function showCounter(focused: boolean, value: string): boolean {
  return focused || codePointLength(value) > COUNTER_FROM;
}

export interface SectionGroup {
  group: CommandField | null;
  sections: readonly CommandField[];
}

export function rootOptions(fields: readonly CommandField[]): CommandField[] {
  return fields.filter((field) => field.kind === 'option');
}

export function sectionGroups(fields: readonly CommandField[]): SectionGroup[] {
  const groups: { group: CommandField | null; sections: CommandField[] }[] = [];

  for (const field of fields) {
    if (field.kind === 'group') {
      groups.push({
        group: field,
        sections: field.children.filter((child) => child.kind === 'subcommand'),
      });
      continue;
    }

    if (field.kind !== 'subcommand') continue;

    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === null) last.sections.push(field);
    else groups.push({ group: null, sections: [field] });
  }

  return groups;
}

export function subcommandCount(fields: readonly CommandField[]): number {
  return flatFields(fields).filter((field) => field.kind === 'subcommand').length;
}

export const COLLAPSE_ABOVE = 3;

export function collapsesSections(fields: readonly CommandField[]): boolean {
  return subcommandCount(fields) > COLLAPSE_ABOVE;
}

export function sectionPaths(section: CommandField): string[] {
  return [section.path, ...flatFields(section.children).map((field) => field.path)];
}

export function sectionHasOverride(section: CommandField, draft: CommandDraft): boolean {
  return sectionPaths(section).some((path) => (draft.options[path] ?? '').trim() !== '');
}

export function sectionHasIssue(
  section: CommandField,
  live: DraftIssues,
  server: ServerIssues,
): boolean {
  return sectionPaths(section).some(
    (path) => live.options[path] !== undefined || server.options[path] !== undefined,
  );
}

export function spokenPath(commandName: string, path: string): string {
  return path === '' ? `/${commandName}` : `/${commandName} ${path.split('.').join(' ')}`;
}

export interface ReplySummary {
  defaultPrivate: boolean | 'mixed';
  alwaysPrivate: readonly string[];
  alwaysPublic: readonly string[];
}

export function replySummary(reply: ReplyControl): ReplySummary {
  const toggleable = reply.paths.filter((path) => path.toggleable);
  const privately = toggleable.filter((path) => path.default === 'private').length;

  return {
    defaultPrivate: privately === 0 ? false : privately === toggleable.length ? true : 'mixed',
    alwaysPrivate: reply.paths
      .filter((path) => !path.toggleable && path.default === 'private')
      .map((path) => path.path),
    alwaysPublic: reply.paths
      .filter((path) => !path.toggleable && path.default === 'public')
      .map((path) => path.path),
  };
}

export function replyShown(draft: CommandDraft, summary: ReplySummary): boolean {
  if (draft.privateReply !== null) return draft.privateReply;
  return summary.defaultPrivate === true;
}
