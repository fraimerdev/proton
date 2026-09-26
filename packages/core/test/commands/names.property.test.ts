import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  type CommandKind,
  type CommandNameEntry,
  nameClash,
  resolveCommandNames,
} from '../../src/commands/names.ts';

const POOL = ['ban', 'kick', 'warn', 'note', 'tag', 'Ban', 'NOTE', 'x', 'y', 'z'];
const TIMES = [null, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'not a date'];

function comparable(kind: CommandKind, name: string): string {
  return kind === 'chat' ? name : name.toLowerCase();
}

const guild: fc.Arbitrary<CommandNameEntry[]> = fc
  .uniqueArray(
    fc.record({
      kind: fc.constantFrom<CommandKind>('chat', 'user', 'message'),
      defaultName: fc.constantFrom(...POOL, 'a', 'b', 'c', 'd', 'e', 'f'),
    }),
    {
      maxLength: 14,
      selector: ({ kind, defaultName }) => `${kind}:${comparable(kind, defaultName)}`,
    },
  )
  .chain((defaults) =>
    fc.tuple(
      ...defaults.map(({ kind, defaultName }) =>
        fc.record({
          key: fc.constant(kind === 'chat' ? defaultName : `${kind}:${defaultName}`),
          kind: fc.constant(kind),
          defaultName: fc.constant(defaultName),
          customName: fc.option(fc.constantFrom(...POOL, ' '), { nil: null }),
          updatedAt: fc.constantFrom(...TIMES),
        }),
      ),
    ),
  );

describe('resolveCommandNames over generated guilds', () => {
  test('never gives two commands of one kind the same name', () => {
    fc.assert(
      fc.property(guild, (entries) => {
        const { names } = resolveCommandNames(entries);

        for (const kind of ['chat', 'user', 'message'] as const) {
          const taken = entries
            .filter((entry) => entry.kind === kind)
            .map((entry) => comparable(kind, names[entry.key] ?? ''));
          expect(new Set(taken).size).toBe(taken.length);
        }
      }),
      { numRuns: 500 },
    );
  });

  test('every command ends on its own custom name or its default, and uncustomized ones never move', () => {
    fc.assert(
      fc.property(guild, (entries) => {
        const { names, ignored } = resolveCommandNames(entries);

        for (const entry of entries) {
          const name = names[entry.key];
          const custom = entry.customName?.trim() ? entry.customName : null;

          expect([entry.defaultName, custom]).toContain(name ?? null);
          if (custom === null) expect(name).toBe(entry.defaultName);
          if (ignored[entry.key] !== undefined) expect(name).toBe(entry.defaultName);
          if (custom !== null && custom !== entry.defaultName && name === entry.defaultName) {
            expect(ignored[entry.key]).toBeDefined();
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  test('is deterministic, whatever order the rows arrive in', () => {
    fc.assert(
      fc.property(
        guild.chain((entries) =>
          fc.tuple(
            fc.constant(entries),
            fc.shuffledSubarray(entries, { minLength: entries.length }),
          ),
        ),
        ([entries, shuffled]) => {
          expect(resolveCommandNames(shuffled)).toEqual(resolveCommandNames(entries));
          expect(resolveCommandNames(entries)).toEqual(resolveCommandNames(entries));
        },
      ),
      { numRuns: 300 },
    );
  });

  test('a name nameClash lets through is not held by any other command', () => {
    fc.assert(
      fc.property(
        guild.filter((entries) => entries.length > 0),
        fc.nat(),
        fc.constantFrom(...POOL),
        (entries, pick, candidate) => {
          const edited = entries[pick % entries.length];
          if (!edited) return;

          const clash = nameClash(entries, edited.key, candidate);
          const { names } = resolveCommandNames(entries);
          const held = entries.some(
            (other) =>
              other.key !== edited.key &&
              other.kind === edited.kind &&
              comparable(other.kind, names[other.key] ?? '') === comparable(edited.kind, candidate),
          );

          expect(clash !== null).toBe(held && candidate !== edited.defaultName);
        },
      ),
      { numRuns: 500 },
    );
  });
});
