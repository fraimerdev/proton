import {
  ANSWER_MAX,
  type AppealPanel,
  type AppealQuestion,
  type AppealsConfig,
  type ApproveAction,
  appealPanelSchema,
  appealQuestionSchema,
  PANEL_ID_MAX,
} from '@proton/module-appeals/config';
import type { ModuleForm } from '../../components/module/form.ts';

export type AppealsForm = ModuleForm<AppealsConfig>;

export const PANEL_NAME_MAX = 80;
export const BLURB_MAX = 2000;
export const MESSAGE_MAX = 2000;
export const REJOIN_URL_MAX = 512;
export const QUESTION_LABEL_MAX = 120;
export const QUESTION_KEY_MAX = 32;
export const PLACEHOLDER_MAX = 100;

export const REVIEW_CHANNEL_TYPES = [0, 5, 11, 12] as const;

export const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const KEY_SHAPE_MESSAGE = 'letters, digits, hyphens and underscores only';

export const OUTCOME_OPTIONS: readonly { value: ApproveAction; label: string }[] = [
  { value: 'unban', label: 'Unban' },
  { value: 'untimeout', label: 'Remove timeout' },
  { value: 'nothing', label: 'No action' },
];

export const OUTCOME_CHIP: Record<ApproveAction, string> = {
  unban: 'Unbans on accept',
  untimeout: 'Removes timeout on accept',
  nothing: 'No action on accept',
};

export function panelIds(config: AppealsConfig, except?: string): Set<string> {
  return new Set(config.panels.filter((panel) => panel.id !== except).map((panel) => panel.id));
}

export function questionKeys(panel: AppealPanel, except?: number): Set<string> {
  return new Set(panel.questions.filter((_, at) => at !== except).map((question) => question.key));
}

export function updatePanel(
  form: AppealsForm,
  panelId: string,
  patch: (panel: AppealPanel) => AppealPanel,
): void {
  form.setValue((current) => ({
    ...current,
    panels: current.panels.map((panel) => (panel.id === panelId ? patch(panel) : panel)),
  }));
}

export function setOptional<T extends Record<string, unknown>>(
  object: T,
  key: string,
  value: string,
): T {
  const next: Record<string, unknown> = { ...object };

  if (value.trim() === '') delete next[key];
  else next[key] = value;

  return next as T;
}

export function slugify(value: string, max: number): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return (slug === '' ? 'form' : slug).slice(0, max);
}

export function uniqueId(base: string, taken: ReadonlySet<string>, max: number): string {
  const trimmed = base.slice(0, max);
  if (!taken.has(trimmed)) return trimmed;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${trimmed.slice(0, max - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }

  return trimmed;
}

export function newPanel(id: string, name: string): AppealPanel {
  return appealPanelSchema.parse({
    id,
    name,
    questions: [
      { key: 'why', label: 'Why should this be reversed?', required: true, maxLength: ANSWER_MAX },
    ],
  });
}

export function newQuestion(taken: ReadonlySet<string>): AppealQuestion {
  return appealQuestionSchema.parse({
    key: uniqueId('answer', taken, QUESTION_KEY_MAX),
    label: 'Anything else the moderators should know?',
  });
}

export function duplicatePanelId(panel: AppealPanel, taken: ReadonlySet<string>): string {
  return uniqueId(slugify(`${panel.id}-copy`, PANEL_ID_MAX), taken, PANEL_ID_MAX);
}

export function panelTitle(panel: AppealPanel): string {
  return panel.name.trim() === '' ? panel.id : panel.name;
}
