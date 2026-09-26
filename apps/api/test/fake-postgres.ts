import type { DbHandle } from '@proton/db';
import * as schema from '@proton/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';

export interface FakeQuery {
  sql: string;
  params: unknown[];
}

export type Respond = (query: FakeQuery) => unknown[][];

function selectList(text: string): string[] {
  if (!text.startsWith('select ')) throw new Error(`not a select: ${text}`);

  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 'select '.length;

  for (let i = start; i < text.length; i++) {
    const character = text[i];

    if (character === '"') quoted = !quoted;
    if (quoted) continue;

    if (character === '(') depth++;
    if (character === ')') depth--;
    if (depth !== 0) continue;

    if (character === ',') {
      items.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (text.startsWith(' from ', i)) {
      items.push(text.slice(start, i).trim());
      return items;
    }
  }

  throw new Error(`no from clause: ${text}`);
}

export function pick(query: FakeQuery, row: Record<string, unknown>): unknown[] {
  return selectList(query.sql).map((item) => {
    const column = /"(\w+)"$/.exec(item)?.[1];
    if (column === undefined || !(column in row)) {
      throw new Error(`the row has nothing for "${item}" in: ${query.sql}`);
    }
    return row[column];
  });
}

export function fakePostgres(respond: Respond = () => []) {
  const queries: FakeQuery[] = [];

  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(text: string, params: unknown[] = []) {
      const query = { sql: text, params };
      queries.push(query);

      return { values: async () => respond(query) };
    },
  };

  const sql = client as unknown as DbHandle['client'];
  const db = drizzle({ client: sql, schema });
  const handle: DbHandle = { db, client: sql, close: async () => undefined };

  return { handle, queries };
}
