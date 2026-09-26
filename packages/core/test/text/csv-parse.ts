export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  let started = false;
  let i = 0;

  const endCell = () => {
    row.push(cell);
    cell = '';
    started = false;
    closed = false;
  };

  while (i < text.length) {
    const ch = text.charAt(i);

    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 2;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
        i += 1;
      } else {
        cell += ch;
        i += 1;
      }
      continue;
    }

    if (ch === ',') {
      endCell();
      i += 1;
    } else if (ch === '\r' && text.charAt(i + 1) === '\n') {
      endCell();
      rows.push(row);
      row = [];
      i += 2;
    } else if (closed) {
      throw new Error(`text after a closing quote at ${i}`);
    } else if (ch === '"') {
      if (started) throw new Error(`a quote inside an unquoted cell at ${i}`);
      quoted = true;
      started = true;
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      throw new Error(`a bare line break in an unquoted cell at ${i}`);
    } else {
      cell += ch;
      started = true;
      i += 1;
    }
  }

  if (quoted) throw new Error('an unterminated quoted cell');
  if (started || row.length > 0) {
    endCell();
    rows.push(row);
  }
  return rows;
}
