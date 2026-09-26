import { drizzle } from 'drizzle-orm/postgres-js';
import type { DbHandle } from '../src/client.ts';
import * as schema from '../src/schema/index.ts';

export interface FakeQuery {
  sql: string;
  params: unknown[];
}

export type FakeStep = FakeQuery | 'begin' | 'commit' | 'rollback';

export type Respond = (query: FakeQuery) => Record<string, unknown>[];

export function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function topLevelItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < list.length; i++) {
    const character = list[i];
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (depth === 0 && character === ',') {
      items.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }

  items.push(list.slice(start).trim());
  return items;
}

function columnsOf(text: string): string[] {
  const returning = text.lastIndexOf(' returning ');
  const list =
    returning >= 0
      ? text.slice(returning + ' returning '.length)
      : text.slice('select '.length, text.indexOf(' from '));

  return topLevelItems(list).map((item) => {
    const column = /"(\w+)"$/.exec(item)?.[1];
    if (column === undefined) throw new Error(`cannot read a column from "${item}" in: ${text}`);
    return column;
  });
}

function asValues(query: FakeQuery, row: Record<string, unknown>): unknown[] {
  return columnsOf(query.sql).map((column) => {
    if (!(column in row)) throw new Error(`the row has nothing for "${column}" in: ${query.sql}`);
    return row[column];
  });
}

export function fakePostgres(respond: Respond = () => []) {
  const steps: FakeStep[] = [];

  const unsafe = (text: string, params: unknown[] = []) => {
    const query = { sql: flat(text), params };
    steps.push(query);
    const rows = respond(query);

    return Object.assign(Promise.resolve(rows), {
      values: async () => rows.map((row) => asValues(query, row)),
    });
  };

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) =>
    unsafe(
      strings
        .slice(1)
        .reduce((text, part, index) => `${text}$${index + 1}${part}`, strings[0] ?? ''),
      values,
    );

  const client = Object.assign(tagged, {
    options: { parsers: {}, serializers: {} },
    unsafe,
    async begin<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
      steps.push('begin');
      try {
        const result = await work(client);
        steps.push('commit');
        return result;
      } catch (error) {
        steps.push('rollback');
        throw error;
      }
    },
  });

  const sql = client as unknown as DbHandle['client'];
  const handle: DbHandle = {
    db: drizzle({ client: sql, schema }),
    client: sql,
    close: async () => undefined,
  };

  const queries = (): FakeQuery[] =>
    steps.filter((step): step is FakeQuery => typeof step !== 'string');

  return { handle, steps, queries };
}
