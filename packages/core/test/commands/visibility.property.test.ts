import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { subcommandPath } from '../../src/commands/visibility.ts';
import { createCommandOptions, OptionType, type RawOption } from '../../src/modules/options.ts';

const name = fc.oneof(fc.stringMatching(/^[a-z][a-z0-9_-]{0,6}$/), fc.constant(''));

const value: fc.Arbitrary<RawOption> = fc.record({
  name,
  type: fc.constantFrom(
    OptionType.String,
    OptionType.Integer,
    OptionType.Boolean,
    OptionType.User,
    OptionType.Number,
  ),
  value: fc.oneof(fc.string({ maxLength: 5 }), fc.integer(), fc.boolean()),
});

const { tree } = fc.letrec<{ tree: RawOption }>((self) => ({
  tree: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    value,
    fc.record(
      {
        name,
        type: fc.constantFrom(OptionType.Subcommand, OptionType.SubcommandGroup),
        options: fc.array(self('tree'), { maxLength: 3 }),
      },
      { requiredKeys: ['name', 'type'] },
    ),
  ),
}));

const raw = fc.option(fc.array(tree, { maxLength: 3 }), { nil: undefined });

describe('subcommandPath', () => {
  test('equals the path the option reader derives, for any options Discord could send', () => {
    fc.assert(
      fc.property(raw, (options) => {
        const reader = createCommandOptions(options);
        const expected = [reader.getSubcommandGroup(), reader.getSubcommand()]
          .filter(Boolean)
          .join('.');

        expect(subcommandPath(options)).toBe(expected);
      }),
      { numRuns: 1000 },
    );
  });

  test('for a well-formed invocation it is the leaf path of the subcommand that ran', () => {
    const invocation = fc.oneof(
      fc.record({ sub: name.filter(Boolean) }).map(({ sub }) => ({
        path: sub,
        options: [{ name: sub, type: OptionType.Subcommand, options: [] }] as RawOption[],
      })),
      fc
        .record({ group: name.filter(Boolean), sub: name.filter(Boolean) })
        .map(({ group, sub }) => ({
          path: `${group}.${sub}`,
          options: [
            {
              name: group,
              type: OptionType.SubcommandGroup,
              options: [{ name: sub, type: OptionType.Subcommand, options: [] }],
            },
          ] as RawOption[],
        })),
    );

    fc.assert(
      fc.property(invocation, ({ path, options }) => {
        expect(subcommandPath(options)).toBe(path);
      }),
    );
  });
});
