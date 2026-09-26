import { describe, expect, test } from 'bun:test';
import { csvCell, toCsv } from '../../src/text/csv.ts';
import { parseCsv } from './csv-parse.ts';

describe('csvCell', () => {
  test('leaves plain text alone', () => {
    expect(csvCell('Moderator Application')).toBe('Moderator Application');
  });

  test.each([
    ['=HYPERLINK("http://evil.example")', `"'=HYPERLINK(""http://evil.example"")"`],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\r=1', `"'\r=1"`],
  ])('neutralises a cell a spreadsheet would run: %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  test('quotes a comma, a quote and both kinds of line break, doubling the quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('line\rbreak')).toBe('"line\rbreak"');
  });

  test('writes nothing for a missing value', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  test('writes numbers and booleans as text, and a negative number cannot become a formula', () => {
    expect(csvCell(12)).toBe('12');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(-5)).toBe("'-5");
  });

  test('only a leading formula character is neutralised', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('score: -1')).toBe('score: -1');
  });
});

describe('toCsv', () => {
  test('writes a header and rows with CRLF line ends and no byte order mark', () => {
    const csv = toCsv(
      ['Reference', 'Status', 'Score'],
      [
        [12, 'accepted', 4],
        [13, 'rejected', null],
      ],
    );

    expect(csv).toBe('Reference,Status,Score\r\n12,accepted,4\r\n13,rejected,\r\n');
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  test('writes a header alone when there are no rows', () => {
    expect(toCsv(['Reference'], [])).toBe('Reference\r\n');
  });

  test('writes dates as ISO timestamps and other values as JSON', () => {
    const csv = toCsv(
      ['At', 'Tags', 'Big'],
      [[new Date(Date.UTC(2026, 8, 24, 10, 0, 0)), ['a', 'b'], 12n]],
    );

    expect(parseCsv(csv)[1]).toEqual(['2026-09-24T10:00:00.000Z', '["a","b"]', '12']);
  });

  test('an invalid date is an empty cell rather than a thrown export', () => {
    expect(toCsv(['At'], [[new Date(Number.NaN)]])).toBe('At\r\n\r\n');
  });

  test('neutralises a formula in the header as well as in the rows', () => {
    expect(parseCsv(toCsv(['=cmd'], [['@cmd']]))).toEqual([["'=cmd"], ["'@cmd"]]);
  });

  test('keeps a multi-line answer in one cell', () => {
    const rows = parseCsv(toCsv(['Answer'], [['first line\r\nsecond line, with a comma']]));

    expect(rows).toEqual([['Answer'], ['first line\r\nsecond line, with a comma']]);
  });
});
