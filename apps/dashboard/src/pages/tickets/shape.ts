import { TICKET_PRIORITIES, type TicketPriority } from '@proton/core';
import {
  type PlaceholderSurface,
  SAMPLE_MEMBER,
  SAMPLE_SERVER,
  SAMPLE_TICKET_OPEN,
  type SurfaceDiagnostic,
  type SurfaceSample,
  type TemplateReport,
  validateConfigTemplates,
} from '@proton/core/placeholders';
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
  ticketsConfigSchema,
} from '@proton/module-tickets/config';
import {
  TICKET_CLOSE_SURFACE,
  TICKET_NAME_SURFACE,
  TICKET_RESPONSE_SURFACE,
  TICKET_WELCOME_SURFACE,
  type TicketAnswerFacts,
  ticketsTemplates,
} from '@proton/module-tickets/placeholders';
import { useId, useMemo } from 'react';
import type { ModuleForm } from '../../components/module/form.ts';
import type { DynamicPlaceholder } from '../../components/placeholders/autocomplete.ts';
import { visibleDiagnostics } from '../../components/placeholders/template-diagnostics.tsx';
import {
  type PlaceholderAutocomplete,
  usePlaceholderAutocomplete,
} from '../../components/placeholders/use-placeholder-autocomplete.ts';
import { previewText, type TextPreview } from '../../lib/placeholder-preview.ts';

export type TicketsForm = ModuleForm<TicketsConfig>;

// Mirrors TICKET_ACCENT in the module's src/interface.ts; the previews drift if the two differ.
export const TICKET_ACCENT = 0x3874f3;

const NO_DIAGNOSTICS: readonly SurfaceDiagnostic[] = [];

const SAMPLE_ANSWER = 'Sample answer';

function firstSample<F>(surface: PlaceholderSurface<F>): SurfaceSample<F> {
  const sample = surface.samples[0];
  if (sample === undefined) {
    throw new Error(
      `The ${surface.label} placeholders have no sample, so nothing can be previewed.`,
    );
  }
  return sample;
}

const NAME_SAMPLE = firstSample(TICKET_NAME_SURFACE);
const WELCOME_SAMPLE = firstSample(TICKET_WELCOME_SURFACE);
const CLOSE_SAMPLE = firstSample(TICKET_CLOSE_SURFACE);
const RESPONSE_SAMPLE = firstSample(TICKET_RESPONSE_SURFACE);

export const SAMPLE_TICKET_NUMBER = SAMPLE_TICKET_OPEN.number;

function openingCaption(typeName: string): string {
  const member = SAMPLE_MEMBER.user.globalName ?? SAMPLE_MEMBER.user.username ?? 'a member';
  const server = SAMPLE_SERVER.name ?? 'your server';
  return `Sample: ${member} opening ${typeName} ticket #${SAMPLE_TICKET_NUMBER} in ${server}`;
}

export function useTicketTemplates(form: TicketsForm): TemplateReport {
  const { value, view } = form;
  return useMemo(
    () => validateConfigTemplates(ticketsTemplates, value, view.config),
    [value, view.config],
  );
}

export interface TemplateField {
  autocomplete: PlaceholderAutocomplete;
  diagnostics: readonly SurfaceDiagnostic[];
  diagnosticsId: string;
  describedBy: string | undefined;
  invalid: boolean;
  error: string | undefined;
}

export function useTemplateField({
  surface,
  report,
  path,
  onChange,
  error,
  dynamic,
}: {
  surface: PlaceholderSurface<unknown>;
  report: TemplateReport;
  path: string;
  onChange: (next: string) => void;
  error: string | undefined;
  dynamic?: readonly DynamicPlaceholder[] | undefined;
}): TemplateField {
  const diagnosticsId = useId();
  const diagnostics = report.byPath.get(path) ?? NO_DIAGNOSTICS;
  const autocomplete = usePlaceholderAutocomplete({ surface, path, onChange, dynamic });
  const listed = error !== undefined && diagnostics.some(({ message }) => message === error);

  return {
    autocomplete,
    diagnostics,
    diagnosticsId,
    describedBy: visibleDiagnostics(diagnostics).shown.length > 0 ? diagnosticsId : undefined,
    invalid: error !== undefined || report.blocking.some((issue) => issue.path === path),
    error: listed ? undefined : error,
  };
}

export function namesEachTicket(pattern: string): boolean {
  return ticketsConfigSchema.shape.namePattern.safeParse(pattern).success;
}

export function sampleAnswer(field: TicketFormField): string {
  if (field.style === 'select') return field.options[0]?.value ?? SAMPLE_ANSWER;

  const hint = field.placeholder?.trim() ?? '';
  return hint === '' ? SAMPLE_ANSWER : hint;
}

function askedFields(types: readonly TicketType[]): TicketFormField[] {
  const seen = new Set<string>();

  return types
    .flatMap((type) => modalFields(type))
    .filter((field) => {
      if (seen.has(field.id)) return false;
      seen.add(field.id);
      return true;
    });
}

export function answerPlaceholders(types: readonly TicketType[]): DynamicPlaceholder[] {
  return askedFields(types).map((field) => ({
    key: `ticket.answer.${field.id}`,
    label: field.label === '' ? field.id : field.label,
  }));
}

function sampleAnswers(types: readonly TicketType[]): TicketAnswerFacts[] {
  return askedFields(types).map((field) => ({ fieldId: field.id, value: sampleAnswer(field) }));
}

export function namePreview(path: string, pattern: string, typeName?: string): TextPreview {
  if (typeName === undefined) return previewText(TICKET_NAME_SURFACE, path, pattern, NAME_SAMPLE);

  const preview = previewText(TICKET_NAME_SURFACE, path, pattern, NAME_SAMPLE, { typeName });
  return { ...preview, caption: openingCaption(typeName) };
}

export function openingPreview(type: TicketType, index: number): TextPreview {
  const { ticket } = WELCOME_SAMPLE.facts;
  const preview = previewText(
    TICKET_WELCOME_SURFACE,
    `types.${index}.welcomeMessage`,
    type.welcomeMessage,
    WELCOME_SAMPLE,
    {
      typeName: type.name,
      ticket: ticket === null ? null : { ...ticket, priority: type.defaultPriority },
      answers: sampleAnswers([type]),
    },
  );

  return { ...preview, caption: `${openingCaption(type.name)}. The answers are examples.` };
}

export function closingPreview(text: string): TextPreview {
  return previewText(TICKET_CLOSE_SURFACE, 'closeConfirmation', text, CLOSE_SAMPLE);
}

export function responsePreview(
  types: readonly TicketType[],
  index: number,
  content: string,
): TextPreview {
  return previewText(
    TICKET_RESPONSE_SURFACE,
    `responses.${index}.content`,
    content,
    RESPONSE_SAMPLE,
    { answers: sampleAnswers(types) },
  );
}

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

export function slugTyping(raw: string, max: number): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
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
