import { z } from 'zod';
import { type FormConfig, formIssues, formSchema, type Question, questionsOf } from './config.ts';

const form = formSchema.shape;

export const formSnapshotSchema = z.object({
  formId: form.id,
  name: form.name,
  description: form.description,
  emoji: form.emoji,
  intro: form.intro,
  confirmation: form.confirmation,
  sections: form.sections,
  requirements: form.requirements,
});
export type FormSnapshot = z.infer<typeof formSnapshotSchema>;

export function snapshotOf(config: FormConfig): FormSnapshot {
  return structuredClone({
    formId: config.id,
    name: config.name,
    description: config.description,
    ...(config.emoji === undefined ? {} : { emoji: config.emoji }),
    intro: config.intro,
    confirmation: config.confirmation,
    sections: config.sections,
    requirements: config.requirements,
  });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : stable(item)));
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => [key, stable(item)] as const);

  return Object.fromEntries(entries);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stable(value)) ?? 'null';
}

export function sameSnapshot(a: FormSnapshot, b: FormSnapshot): boolean {
  return stableStringify(a) === stableStringify(b);
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
  requirementsChanged: boolean;
  textChanged: boolean;
}

function questionMap(snapshot: FormSnapshot): Map<string, string> {
  return new Map(
    questionsOf(snapshot).map((question) => [question.id, stableStringify(question)] as const),
  );
}

function formText(snapshot: FormSnapshot): string {
  return stableStringify({
    name: snapshot.name,
    description: snapshot.description,
    emoji: snapshot.emoji,
    intro: snapshot.intro,
    confirmation: snapshot.confirmation,
    sections: snapshot.sections.map(({ id, title, description }) => ({ id, title, description })),
  });
}

export function snapshotDiff(before: FormSnapshot | null, after: FormSnapshot): SnapshotDiff {
  const next = questionMap(after);

  if (before === null) {
    return {
      added: [...next.keys()],
      removed: [],
      changed: [],
      requirementsChanged: true,
      textChanged: true,
    };
  }

  const previous = questionMap(before);

  return {
    added: [...next.keys()].filter((id) => !previous.has(id)),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    changed: [...next.entries()]
      .filter(([id, text]) => previous.has(id) && previous.get(id) !== text)
      .map(([id]) => id),
    requirementsChanged:
      stableStringify(before.requirements) !== stableStringify(after.requirements),
    textChanged: formText(before) !== formText(after),
  };
}

function hasQuestions(sections: readonly { questions: readonly Question[] }[]): boolean {
  return sections.some((section) => section.questions.length > 0);
}

export function publishIssues(config: FormConfig): string[] {
  const issues: string[] = [];

  if (!hasQuestions(config.sections)) {
    issues.push('Add at least one question before publishing.');
  }

  for (const issue of formIssues(config)) issues.push(issue.message);

  return [...new Set(issues)];
}
