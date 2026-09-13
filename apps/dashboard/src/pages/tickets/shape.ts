import { TICKET_PRIORITIES, type TicketPriority } from '@proton/core';
import {
  type ClaimMode,
  FORM_FIELDS_MAX,
  type FormFieldStyle,
  type PanelStyle,
  PRIORITY_COLOUR,
  PRIORITY_LABELS,
  type TicketFormField,
  type TicketPanel,
  type TicketResponse,
  type TicketStatusName,
  type TicketsConfig,
  type TicketType,
  type TranscriptDestination,
} from '@proton/module-tickets/config';
import type { ModuleForm } from '../../components/module/form.ts';

export type TicketsForm = ModuleForm<TicketsConfig>;

// TICKET_ACCENT from the module's src/interface.ts, which has no package export yet. The panel and
// welcome previews are built against it, so a change there has to be mirrored here.
export const TICKET_ACCENT = 0x3874f3;

export const SAMPLE_TICKET_NUMBER = 42;
export const SAMPLE_OPENER = 'ada';
export const SAMPLE_USER_ID = '100000000000000000';

export function hexOf(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}

export const PRIORITY_OPTIONS: readonly { value: TicketPriority; label: string }[] =
  TICKET_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_LABELS[priority] }));

export function priorityHex(priority: TicketPriority): string {
  return hexOf(PRIORITY_COLOUR[priority]);
}

export const CLAIM_MODE_OPTIONS: readonly { value: ClaimMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'single', label: 'One staff member' },
  { value: 'assignable', label: 'One staff member, reassignable' },
];

export const TRANSCRIPT_OPTIONS: readonly { value: TranscriptDestination; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'channel', label: 'Transcript channel' },
  { value: 'owner', label: 'Direct message to the owner' },
  { value: 'both', label: 'Both' },
];

export const PANEL_STYLE_OPTIONS: readonly { value: PanelStyle; label: string }[] = [
  { value: 'buttons', label: 'Buttons' },
  { value: 'select', label: 'Dropdown' },
];

export const FORM_STYLE_OPTIONS: readonly { value: FormFieldStyle; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'select', label: 'Dropdown' },
];

export const STATUS_LABELS: Record<TicketStatusName, string> = {
  open: 'Open',
  closed: 'Closed',
  archived: 'Archived',
  deleted: 'Deleted',
};

export function slugify(raw: string, max: number): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, max);
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>, max: number): string {
  const seed = base === '' ? 'item' : base;
  if (!taken.has(seed)) return seed;

  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const suffix = `-${attempt}`;
    const candidate = `${seed.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  return seed;
}

export function typeIds(config: TicketsConfig): Set<string> {
  return new Set(config.types.map((type) => type.id));
}

export function panelIds(config: TicketsConfig): Set<string> {
  return new Set(config.panels.map((panel) => panel.id));
}

export function responseIds(config: TicketsConfig): Set<string> {
  return new Set(config.responses.map((response) => response.id));
}

export function setTypes(form: TicketsForm, next: TicketType[]): void {
  form.setValue((current) => ({ ...current, types: next }));
}

export function setPanels(form: TicketsForm, next: TicketPanel[]): void {
  form.setValue((current) => ({ ...current, panels: next }));
}

export function setResponses(form: TicketsForm, next: TicketResponse[]): void {
  form.setValue((current) => ({ ...current, responses: next }));
}

export function updateTypeAt(form: TicketsForm, index: number, patch: Partial<TicketType>): void {
  form.setValue((current) => ({
    ...current,
    types: current.types.map((type, at) => (at === index ? { ...type, ...patch } : type)),
  }));
}

export function updatePanelAt(form: TicketsForm, index: number, patch: Partial<TicketPanel>): void {
  form.setValue((current) => ({
    ...current,
    panels: current.panels.map((panel, at) => (at === index ? { ...panel, ...patch } : panel)),
  }));
}

export function updateResponseAt(
  form: TicketsForm,
  index: number,
  patch: Partial<TicketResponse>,
): void {
  form.setValue((current) => ({
    ...current,
    responses: current.responses.map((response, at) =>
      at === index ? { ...response, ...patch } : response,
    ),
  }));
}

export function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const held = next[from];
  if (held === undefined || to < 0 || to >= next.length) return next;

  next.splice(from, 1);
  next.splice(to, 0, held);
  return next;
}

export function panelsCarrying(config: TicketsConfig, typeId: string): TicketPanel[] {
  return config.panels.filter((panel) => panel.typeIds.includes(typeId));
}

export function droppedSelect(field: TicketFormField): boolean {
  return field.style === 'select' && field.options.length === 0;
}

export function duplicateOptionValues(field: TicketFormField): boolean {
  const seen = new Set<string>();

  for (const option of field.options) {
    if (seen.has(option.value)) return true;
    seen.add(option.value);
  }

  return false;
}

/**
 * modalFieldsFor and needsModal, which live in the module's `src/modal.ts`. That file has no
 * package export yet, so the rule is restated here rather than the page guessing at the answer.
 */
export function modalFields(type: TicketType): TicketFormField[] {
  return type.form
    .filter((field) => !droppedSelect(field))
    .slice(0, type.askPriority ? FORM_FIELDS_MAX - 1 : FORM_FIELDS_MAX);
}

export function opensAModal(type: TicketType): boolean {
  return type.askPriority || modalFields(type).length > 0;
}

export function shownInModal(type: TicketType, field: TicketFormField): boolean {
  return modalFields(type).some((candidate) => candidate === field);
}

export function duplicateIds<T extends { id: string }>(entries: readonly T[]): Set<number> {
  const seen = new Set<string>();
  const clashes = new Set<number>();

  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.id)) clashes.add(index);
    seen.add(entry.id);
  }

  return clashes;
}
