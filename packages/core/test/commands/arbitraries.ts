import { ApplicationCommandOptionType as T } from 'discord-api-types/v10';
import fc from 'fast-check';
import type { ChatCommandData } from '../../src/commands/fields.ts';

export const optionName = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/);

const text = fc.string({ minLength: 1, maxLength: 40 });

const localizations = fc.option(
  fc.dictionary(fc.constantFrom('fr', 'de', 'es-ES', 'ja'), fc.string({ maxLength: 30 }), {
    maxKeys: 3,
  }),
  { nil: undefined },
);

function present<V extends Record<string, unknown>>(value: V): V {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as V;
}

const leaf = fc
  .record({
    type: fc.constantFrom(
      T.String,
      T.Integer,
      T.Number,
      T.Boolean,
      T.User,
      T.Channel,
      T.Role,
      T.Mentionable,
      T.Attachment,
    ),
    name: optionName,
    name_localizations: localizations,
    description: text,
    description_localizations: localizations,
    required: fc.option(fc.boolean(), { nil: undefined }),
    autocomplete: fc.option(fc.boolean(), { nil: undefined }),
    min_value: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
    max_length: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    channel_types: fc.option(fc.array(fc.constantFrom(0, 2, 4, 5), { maxLength: 3 }), {
      nil: undefined,
    }),
    choices: fc.option(
      fc.array(
        fc.record({
          name: text,
          name_localizations: localizations,
          value: fc.oneof(fc.string({ maxLength: 20 }), fc.integer()),
        }),
        { maxLength: 4 },
      ),
      { nil: undefined },
    ),
  })
  .map(present);

const leaves = fc.uniqueArray(leaf, { maxLength: 4, selector: (option) => option.name });

const subcommand = fc
  .record({
    type: fc.constant(T.Subcommand),
    name: optionName,
    description: text,
    description_localizations: localizations,
    options: fc.option(leaves, { nil: undefined }),
  })
  .map(present);

const group = fc
  .record({
    type: fc.constant(T.SubcommandGroup),
    name: optionName,
    description: text,
    description_localizations: localizations,
    options: fc.uniqueArray(subcommand, {
      minLength: 1,
      maxLength: 3,
      selector: (sub) => sub.name,
    }),
  })
  .map(present);

const branches = fc.uniqueArray(fc.oneof(subcommand, group), {
  minLength: 1,
  maxLength: 4,
  selector: (branch) => branch.name,
});

export const chatCommand: fc.Arbitrary<ChatCommandData> = fc
  .record({
    name: optionName,
    name_localizations: localizations,
    description: text,
    description_localizations: localizations,
    default_member_permissions: fc.option(fc.constantFrom('8', '8192', null), { nil: undefined }),
    nsfw: fc.option(fc.boolean(), { nil: undefined }),
    contexts: fc.option(fc.constant([0]), { nil: undefined }),
    options: fc.option(fc.oneof(leaves, branches), { nil: undefined }),
  })
  .map((command) => present(command) as unknown as ChatCommandData);

export function pathsOf(data: ChatCommandData): string[] {
  const paths: string[] = [];

  const visit = (options: unknown[] | undefined, prefix: string) => {
    for (const option of (options ?? []) as Array<{ name: string; type: number; options?: [] }>) {
      const path = prefix === '' ? option.name : `${prefix}.${option.name}`;
      paths.push(path);
      if (option.type === T.Subcommand || option.type === T.SubcommandGroup) {
        visit(option.options, path);
      }
    }
  };
  visit(data.options, '');

  return paths;
}

export const overrideText = fc.oneof(
  fc.string({ minLength: 1, maxLength: 60 }),
  fc.constantFrom('', '   ', ' padded '),
);

export function overridesFor(data: ChatCommandData): fc.Arbitrary<Record<string, string>> {
  const known = pathsOf(data);
  const path = known.length > 0 ? fc.oneof(fc.constantFrom(...known), optionName) : optionName;

  return fc.dictionary(path, overrideText, { maxKeys: 8 });
}
