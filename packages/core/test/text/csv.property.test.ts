import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { CSV_FORMULA_LEADS, csvCell, toCsv } from '../../src/text/csv.ts';
import { parseCsv } from './csv-parse.ts';

const tricky = fc.string({
  unit: fc.constantFrom(...CSV_FORMULA_LEADS, '"', ',', '\n', "'", ' ', 'a', 'Z', '1', 'é', '😀'),
  maxLength: 12,
});

const text = fc.oneof(tricky, fc.string({ unit: 'binary', maxLength: 24 }), fc.string());

const value = fc.oneof(
  text,
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ noNaN: true }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
);

const table = fc.record({
  header: fc.array(text, { minLength: 1, maxLength: 5 }),
  rows: fc.array(fc.array(value, { minLength: 1, maxLength: 5 }), { maxLength: 6 }),
});

function expected(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  const raw = String(cell);
  return CSV_FORMULA_LEADS.includes(raw.charAt(0)) ? `'${raw}` : raw;
}

describe('csv properties', () => {
  test('no parsed cell ever starts with a formula character', () => {
    fc.assert(
      fc.property(table, ({ header, rows }) => {
        for (const row of parseCsv(toCsv(header, rows))) {
          for (const cell of row) {
            if (CSV_FORMULA_LEADS.includes(cell.charAt(0))) return false;
          }
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  test('every cell parses back to exactly what was written, apart from the neutralising quote', () => {
    fc.assert(
      fc.property(table, ({ header, rows }) => {
        const parsed = parseCsv(toCsv(header, rows));
        const wanted = [header, ...rows].map((row) => row.map(expected));

        expect(parsed).toEqual(wanted);
      }),
      { numRuns: 500 },
    );
  });

  test('one cell is always one field, whatever it holds', () => {
    fc.assert(
      fc.property(text, (cell) => {
        const parsed = parseCsv(`${csvCell(cell)}\r\n`);
        return parsed.length === 1 && parsed[0]?.length === 1 && parsed[0][0] === expected(cell);
      }),
      { numRuns: 1000 },
    );
  });

  test('a cell that needs no quoting and no neutralising is written unchanged', () => {
    fc.assert(
      fc.property(text, (cell) => {
        fc.pre(!/[",\r\n]/.test(cell) && !CSV_FORMULA_LEADS.includes(cell.charAt(0)));
        return csvCell(cell) === cell;
      }),
      { numRuns: 500 },
    );
  });
});
