import { afterAll, describe, expect, test } from 'bun:test';
import { createDb } from '../src/client.ts';
import { guildRowSchema } from '../src/purge.ts';

const handle = createDb('postgres://purge:purge@127.0.0.1:9/purge');
const { parsers } = handle.client.options;

const TIMESTAMPTZ = 1184;
const FLOAT8 = 701;

afterAll(() => handle.close());

const raw = (type: number, text: string): unknown => {
  const parse = parsers[type];
  if (!parse) throw new Error(`createDb installed no parser for type ${type}`);
  return parse(text);
};

describe('the guilds row as createDb’s driver hands it to a raw query', () => {
  test('a timestamptz column arrives as unparsed text, so it cannot be read as a Date', () => {
    expect(raw(TIMESTAMPTZ, '2026-09-18 12:00:00+00')).toBe('2026-09-18 12:00:00+00');
  });

  test('epoch milliseconds arrive as numbers and become the join and leave times', () => {
    const guild = guildRowSchema.parse({
      id: '900000000000000001',
      name: 'Tea Club',
      joined_ms: raw(FLOAT8, '1789732800000'),
      left_ms: raw(FLOAT8, '1789743600000.25'),
    });

    expect(guild.joinedAt.toISOString()).toBe('2026-09-18T12:00:00.000Z');
    expect(guild.leftAt?.toISOString()).toBe('2026-09-18T15:00:00.000Z');
  });

  test('a server Proton is still in has no leave time', () => {
    const guild = guildRowSchema.parse({
      id: '900000000000000001',
      name: 'Tea Club',
      joined_ms: raw(FLOAT8, '1789732800000'),
      left_ms: null,
    });

    expect(guild.leftAt).toBeNull();
  });

  test('a raw timestamp column is refused on read instead of failing later in the report', () => {
    expect(() =>
      guildRowSchema.parse({
        id: '900000000000000001',
        name: 'Tea Club',
        joined_ms: raw(TIMESTAMPTZ, '2026-09-18 12:00:00+00'),
        left_ms: null,
      }),
    ).toThrow();
  });
});
