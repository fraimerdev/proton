import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  applyCommandSettings,
  commandSize,
  fixedSize,
  normalizeCommandInput,
} from '../../src/commands/effective.ts';
import { commandSettingsSchema } from '../../src/commands/settings.ts';
import { chatCommand, optionName, overridesFor, overrideText } from './arbitraries.ts';

type Node = Record<string, unknown> & {
  name: string;
  description?: string;
  type?: number;
  options?: Node[];
};

const EDITABLE = new Set([
  'name',
  'description',
  'name_localizations',
  'description_localizations',
  'options',
]);

function filled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function assertOnlyEditableChanged(
  applied: Node,
  code: Node,
  path: string,
  customization: {
    name: string | null;
    description: string | null;
    options: Record<string, string>;
  },
): void {
  const root = path === '';

  for (const key of new Set([...Object.keys(applied), ...Object.keys(code)])) {
    if (!EDITABLE.has(key))
      expect({ path, key, value: applied[key] }).toEqual({ path, key, value: code[key] });
  }

  const renamed = root && filled(customization.name) && customization.name !== code.name;
  expect(applied.name).toBe((renamed ? customization.name : code.name) ?? '');
  if (renamed) expect('name_localizations' in applied).toBe(false);
  else expect(applied.name_localizations).toEqual(code.name_localizations);

  const override = root
    ? customization.description
    : Object.hasOwn(customization.options, path)
      ? customization.options[path]
      : undefined;
  const redescribed = filled(override) && override !== code.description;
  expect(applied.description).toBe(redescribed ? override : code.description);
  if (redescribed) expect('description_localizations' in applied).toBe(false);
  else expect(applied.description_localizations).toEqual(code.description_localizations);

  const branch = root || code.type === 1 || code.type === 2;
  if (!branch) {
    expect(applied.options).toEqual(code.options);
    return;
  }

  expect(applied.options?.length).toBe(code.options?.length);
  for (const [index, child] of (code.options ?? []).entries()) {
    const next = applied.options?.[index];
    if (!next) throw new Error(`option ${index} vanished under '${path}'`);
    assertOnlyEditableChanged(
      next,
      child,
      path === '' ? child.name : `${path}.${child.name}`,
      customization,
    );
  }
}

const customized = chatCommand.chain((data) =>
  fc.record({
    data: fc.constant(data),
    name: fc.option(fc.oneof(optionName, overrideText, fc.constant(data.name)), { nil: null }),
    description: fc.option(fc.oneof(overrideText, fc.constant(data.description)), { nil: null }),
    optionDescriptions: overridesFor(data),
  }),
);

describe('applyCommandSettings over generated option trees', () => {
  test('changes nothing but names, descriptions and the localizations of overridden fields', () => {
    fc.assert(
      fc.property(customized, ({ data, name, description, optionDescriptions }) => {
        const code = structuredClone(data);
        const applied = applyCommandSettings(data, { name, description, optionDescriptions });

        expect(data).toEqual(code);
        assertOnlyEditableChanged(applied as unknown as Node, code as unknown as Node, '', {
          name,
          description,
          options: optionDescriptions,
        });
      }),
      { numRuns: 300 },
    );
  });

  test('applying the same settings twice is the same as applying them once', () => {
    fc.assert(
      fc.property(customized, ({ data, name, description, optionDescriptions }) => {
        const settings = { name, description, optionDescriptions };
        const once = applyCommandSettings(data, settings);

        expect(applyCommandSettings(once, settings)).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });

  test('the size of the parts an admin cannot edit never moves', () => {
    fc.assert(
      fc.property(customized, ({ data, name, description, optionDescriptions }) => {
        const applied = applyCommandSettings(data, { name, description, optionDescriptions });

        expect(fixedSize(applied)).toBe(fixedSize(data));
        expect(commandSize(applied)).toBeGreaterThanOrEqual(fixedSize(data));
      }),
      { numRuns: 200 },
    );
  });
});

describe('normalizeCommandInput over generated option trees', () => {
  test('normalizing what it produced changes nothing', () => {
    fc.assert(
      fc.property(customized, fc.option(fc.boolean(), { nil: null }), (input, privateReply) => {
        const stored = commandSettingsSchema.parse({
          optionDescriptions: { 'retired.path': 'Kept for a rollback.' },
        });
        const once = normalizeCommandInput(input.data, stored, {
          name: input.name,
          description: input.description,
          optionDescriptions: input.optionDescriptions,
          privateReply,
        });
        fc.pre(once.name === null || !once.name.startsWith('/'));

        const twice = normalizeCommandInput(input.data, once, {
          name: once.name,
          description: once.description,
          optionDescriptions: once.optionDescriptions,
          privateReply: once.privateReply,
        });

        expect(twice).toEqual(once);

        const reset =
          once.name === null &&
          once.description === null &&
          once.privateReply === null &&
          Object.keys(once.optionDescriptions).every((path) => path === 'retired.path');
        expect(once.optionDescriptions['retired.path']).toBe(
          reset ? undefined : 'Kept for a rollback.',
        );
      }),
      { numRuns: 200 },
    );
  });

  test('what it stores never restates a default and is never blank', () => {
    fc.assert(
      fc.property(customized, (input) => {
        const normalized = normalizeCommandInput(input.data, commandSettingsSchema.parse({}), {
          name: input.name,
          description: input.description,
          optionDescriptions: input.optionDescriptions,
          privateReply: null,
        });
        const applied = applyCommandSettings(input.data, normalized);

        if (normalized.name !== null) {
          expect(normalized.name).not.toBe(input.data.name);
          expect(normalized.name.trim()).toBe(normalized.name);
          expect(normalized.name).toBe(normalized.name.toLowerCase());
        }
        if (normalized.description !== null) {
          expect(normalized.description).not.toBe(input.data.description);
          expect(applied.description).toBe(normalized.description);
        }
        for (const value of Object.values(normalized.optionDescriptions)) {
          expect(value.trim()).toBe(value);
          expect(value).not.toBe('');
        }
      }),
      { numRuns: 200 },
    );
  });
});
