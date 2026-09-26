import { describe, expect, test } from 'bun:test';
import {
  applyCommandSettings,
  type CatalogueEntry,
  type ChatCommandData,
  commandCatalogue,
  commandFields,
  commandSettingsSchema,
  effectiveCommandSet,
  fieldPaths,
  leafPaths,
  MAX_CHAT_COMMANDS,
  resolveCommandNames,
  type StoredCommandSettings,
  validateCommand,
} from '@proton/core';
import fc from 'fast-check';
import { createModuleRegistry, MODULES } from '../src/index.ts';

const catalogue = commandCatalogue(createModuleRegistry());
const chat = catalogue.filter(
  (entry): entry is Extract<CatalogueEntry, { kind: 'chat' }> => entry.kind === 'chat',
);

type Node = Record<string, unknown> & { name: string; type?: number; options?: Node[] };

function filled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

describe('every shipped command', () => {
  test.each(chat.map((entry) => [entry.key, entry] as const))(
    '/%s registers the data its own name promises',
    (_key, entry) => {
      expect(entry.data.name).toBe(entry.command.name);
      expect(entry.data.description).toBe(entry.command.description);
    },
  );

  test.each(chat.map((entry) => [entry.key, entry.data] as const))(
    '/%s is a definition Discord would accept',
    (_key, data) => {
      expect(validateCommand(data)).toEqual([]);
    },
  );

  test('slash names are unique and within Discord’s per-server limit', () => {
    const names = chat.map((entry) => entry.data.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(MAX_CHAT_COMMANDS);
  });

  test('every catalogue key is unique, menus included', () => {
    const keys = catalogue.map((entry) => entry.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(catalogue.filter((entry) => entry.kind !== 'chat').map((entry) => entry.key)).toEqual(
      expect.arrayContaining([
        'user:Report user',
        'message:Report message',
        'message:Punish author',
      ]),
    );
  });

  test('every reply policy toggles only paths its command really has', () => {
    const stray = chat.flatMap((entry) => {
      const leaves = leafPaths(entry.data);
      return (entry.command.reply?.toggleable ?? [])
        .filter((path) => !leaves.includes(path))
        .map((path) => `/${entry.key} toggles '${path}'`);
    });

    expect(stray).toEqual([]);
  });

  test('only /help stays registered while its module is off', () => {
    expect(chat.filter((entry) => entry.alwaysRegistered && entry.key !== 'help')).toEqual([]);
  });

  test('the whole registry registers, so none of these assertions fails a boot', () => {
    expect(() => createModuleRegistry()).not.toThrow();
    expect(createModuleRegistry().all()).toHaveLength(MODULES.length);
  });
});

function pathsOf(data: ChatCommandData): string[] {
  return [...fieldPaths(commandFields(data))];
}

const description = fc.oneof(
  fc.string({ minLength: 1, maxLength: 100 }).filter((text) => text.trim() !== ''),
  fc.constantFrom('', '   '),
);

const customized = fc.constantFrom(...chat).chain((entry) => {
  const paths = pathsOf(entry.data);
  const path = paths.length > 0 ? fc.constantFrom(...paths) : fc.constant('retired');

  return fc.record({
    entry: fc.constant(entry),
    name: fc.option(fc.stringMatching(/^[a-z][a-z0-9_-]{0,31}$/), { nil: null }),
    description: fc.option(description, { nil: null }),
    optionDescriptions: fc.dictionary(fc.oneof(path, fc.constant('retired.path')), description, {
      maxKeys: 10,
    }),
  });
});

function changedOnlyWhatAdminsEdit(applied: Node, code: Node, path: string, edited: Set<string>) {
  for (const key of new Set([...Object.keys(applied), ...Object.keys(code)])) {
    if (key === 'options') continue;
    if (key === 'name' && path === '') continue;
    if ((key === 'description' || key === 'description_localizations') && edited.has(path)) {
      continue;
    }
    if (key === 'name_localizations' && path === '' && edited.has('name')) continue;
    expect({ path, key, value: applied[key] }).toEqual({ path, key, value: code[key] });
  }

  expect(applied.options?.length).toBe(code.options?.length);
  for (const [index, child] of (code.options ?? []).entries()) {
    const next = applied.options?.[index] as Node;
    changedOnlyWhatAdminsEdit(
      next,
      child,
      path === '' ? child.name : `${path}.${child.name}`,
      edited,
    );
  }
}

describe('customizing the real commands', () => {
  test('changes nothing but names, descriptions and their localizations', () => {
    fc.assert(
      fc.property(customized, ({ entry, name, description, optionDescriptions }) => {
        const applied = applyCommandSettings(entry.data, { name, description, optionDescriptions });
        const edited = new Set(
          Object.entries(optionDescriptions)
            .filter(([, value]) => filled(value))
            .map(([path]) => path),
        );
        if (filled(description)) edited.add('');
        if (filled(name)) edited.add('name');

        changedOnlyWhatAdminsEdit(
          applied as unknown as Node,
          entry.data as unknown as Node,
          '',
          edited,
        );
      }),
      { numRuns: 400 },
    );
  });

  test('an issue only ever lands on something the admin changed, or on the size', () => {
    fc.assert(
      fc.property(customized, ({ entry, name, description, optionDescriptions }) => {
        const applied = applyCommandSettings(entry.data, { name, description, optionDescriptions });
        const allowed = new Set(['name', 'description', 'size']);
        for (const [path, value] of Object.entries(optionDescriptions)) {
          if (filled(value)) allowed.add(`options.${path}`);
        }

        for (const issue of validateCommand(applied)) expect(allowed).toContain(issue.path);
      }),
      { numRuns: 400 },
    );
  });

  test('the registered set keeps every option, name and type exactly as the code has them', () => {
    const settings = fc.dictionary(
      fc.constantFrom(...catalogue.map((entry) => entry.key)),
      fc.record({
        enabled: fc.boolean(),
        name: fc.option(fc.constantFrom(...chat.map((entry) => entry.key), 'punish', 'boot'), {
          nil: null,
        }),
        description: fc.option(description, { nil: null }),
        optionDescriptions: fc.constant({}),
        privateReply: fc.option(fc.boolean(), { nil: null }),
        updatedAt: fc.constantFrom(null, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
      }),
      { maxKeys: 12 },
    );
    const modulesOn = fc.dictionary(fc.constantFrom(...MODULES.map((m) => m.id)), fc.boolean());

    fc.assert(
      fc.property(settings, modulesOn, (stored, on) => {
        const { commands } = effectiveCommandSet({
          catalogue,
          modulesOn: on,
          settings: stored as Record<string, StoredCommandSettings>,
        });

        const byKind = new Map<string, string[]>();
        for (const { key, kind, body } of commands) {
          const entry = catalogue.find((candidate) => candidate.key === key) as CatalogueEntry;
          const shape = (node: unknown): unknown =>
            ((node as Node).options ?? []).map((option) => ({
              name: option.name,
              type: option.type,
              options: shape(option),
            }));

          expect(shape(body)).toEqual(shape(entry.data));
          byKind.set(kind, [
            ...(byKind.get(kind) ?? []),
            kind === 'chat' ? body.name : body.name.toLowerCase(),
          ]);
        }

        for (const names of byKind.values()) expect(new Set(names).size).toBe(names.length);
        expect(commands.filter(({ kind }) => kind === 'chat').length).toBeLessThanOrEqual(
          MAX_CHAT_COMMANDS,
        );
      }),
      { numRuns: 300 },
    );
  });

  test('resolving names over the real catalogue never hands one name to two commands', () => {
    const custom = fc.array(
      fc.record({
        key: fc.constantFrom(...chat.map((entry) => entry.key)),
        name: fc.constantFrom(...chat.map((entry) => entry.key)),
      }),
      { maxLength: 15 },
    );

    fc.assert(
      fc.property(custom, (picks) => {
        const chosen = new Map(picks.map(({ key, name }) => [key, name]));
        const { names } = resolveCommandNames(
          chat.map((entry) => ({
            key: entry.key,
            kind: 'chat' as const,
            defaultName: entry.data.name,
            customName: chosen.get(entry.key) ?? null,
            updatedAt: null,
          })),
        );

        expect(new Set(Object.values(names)).size).toBe(chat.length);
      }),
      { numRuns: 300 },
    );
  });

  test('the stored defaults register exactly the code definitions', () => {
    const everyModule = Object.fromEntries(MODULES.map((m) => [m.id, true]));
    const { commands, ignored } = effectiveCommandSet({
      catalogue,
      modulesOn: everyModule,
      settings: Object.fromEntries(
        catalogue.map((entry) => [
          entry.key,
          { ...commandSettingsSchema.parse({}), updatedAt: null },
        ]),
      ),
    });

    expect(ignored).toEqual({});
    expect(commands.map(({ body }) => body)).toEqual(catalogue.map((entry) => entry.data));
  });
});
