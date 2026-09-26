import { toCsv } from '@proton/core';
import type { ApplicationRecord } from '@proton/module-applications/store';
import { referenceOf, STATUS_LABELS } from '@proton/module-applications/web';

export interface ExportColumn {
  id: string;
  label: string;
}

export interface ExportInput {
  guildId: string;
  format: 'csv' | 'json';
  rows: readonly ApplicationRecord[];
  truncated: boolean;
  formName(formId: string): string;
  questions: readonly ExportColumn[] | null;
  exportedAt: number;
}

export interface ExportFile {
  contentType: string;
  filename: string;
  body: string;
  rows: number;
  truncated: boolean;
}

const HEADER = [
  'Reference',
  'Application ID',
  'Form',
  'Applicant ID',
  'Applicant name',
  'Status',
  'Submitted (UTC)',
  'Decided (UTC)',
  'Decided by',
  'Decision reason',
  'Archived',
] as const;

function iso(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString();
}

export function exportColumns(
  published: readonly ExportColumn[],
  rows: readonly ApplicationRecord[],
): ExportColumn[] {
  const columns = [...published];
  const seen = new Set(columns.map((column) => column.id));

  for (const row of rows) {
    for (const answer of row.answers ?? []) {
      if (seen.has(answer.questionId)) continue;
      seen.add(answer.questionId);
      columns.push({ id: answer.questionId, label: answer.label });
    }
  }

  return columns;
}

function baseCells(input: ExportInput, row: ApplicationRecord): unknown[] {
  return [
    referenceOf(row.number),
    row.id,
    input.formName(row.formId),
    row.applicantId,
    row.applicantName,
    STATUS_LABELS[row.status],
    iso(row.submittedAt),
    iso(row.decidedAt),
    row.decidedBy,
    row.decisionReason,
    row.archivedAt === null ? 'no' : 'yes',
  ];
}

function answerCells(row: ApplicationRecord, columns: readonly ExportColumn[]): string[] {
  const shown = new Map((row.answers ?? []).map((answer) => [answer.questionId, answer.display]));
  return columns.map((column) => shown.get(column.id) ?? '');
}

function jsonRow(input: ExportInput, row: ApplicationRecord) {
  return {
    reference: referenceOf(row.number),
    id: row.id,
    formId: row.formId,
    formName: input.formName(row.formId),
    applicantId: row.applicantId,
    applicantName: row.applicantName,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    submittedAt: iso(row.submittedAt) || null,
    decidedAt: iso(row.decidedAt) || null,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
    archived: row.archivedAt !== null,
    answers:
      row.answers === null
        ? null
        : row.answers.map(({ questionId, label, value, display }) => ({
            questionId,
            label,
            value,
            display,
          })),
  };
}

export function exportFile(input: ExportInput): ExportFile {
  const stamp = new Date(input.exportedAt).toISOString().slice(0, 10);
  const name = `applications-${input.guildId}-${stamp}`;

  if (input.format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `${name}.json`,
      body: JSON.stringify(
        {
          exportedAt: new Date(input.exportedAt).toISOString(),
          truncated: input.truncated,
          count: input.rows.length,
          applications: input.rows.map((row) => jsonRow(input, row)),
        },
        null,
        2,
      ),
      rows: input.rows.length,
      truncated: input.truncated,
    };
  }

  const columns = input.questions ?? [];
  return {
    contentType: 'text/csv; charset=utf-8',
    filename: `${name}.csv`,
    body: toCsv(
      [...HEADER, ...columns.map((column) => column.label)],
      input.rows.map((row) => [...baseCells(input, row), ...answerCells(row, columns)]),
    ),
    rows: input.rows.length,
    truncated: input.truncated,
  };
}
