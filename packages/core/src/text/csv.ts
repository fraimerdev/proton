export const CSV_FORMULA_LEADS: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];

const FORMULA_LEADS: ReadonlySet<string> = new Set(CSV_FORMULA_LEADS);

const NEEDS_QUOTES = /[",\n\r]/;

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';

  const text = String(value);
  const inert = FORMULA_LEADS.has(text.charAt(0)) ? `'${text}` : text;
  return NEEDS_QUOTES.test(inert) ? `"${inert.replaceAll('"', '""')}"` : inert;
}

function cellOf(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return csvCell(value);
  }
  if (typeof value === 'bigint') return csvCell(value.toString());
  if (value instanceof Date) {
    return csvCell(Number.isNaN(value.getTime()) ? '' : value.toISOString());
  }
  return csvCell(JSON.stringify(value) ?? '');
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((row) => `${row.map(cellOf).join(',')}\r\n`).join('');
}
