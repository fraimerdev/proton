import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type ChannelIdField,
  protonFields,
  type StringField,
  UnsupportedSchemaError,
  zodToDescriptors,
} from '../../src/config/descriptor.ts';

describe('zodToDescriptors', () => {
  test('maps z.boolean() to a boolean field', () => {
    const [field] = zodToDescriptors(z.object({ enabled: z.boolean() }));

    expect(field).toMatchObject({ kind: 'boolean', path: 'enabled', optional: false });
  });

  test('maps z.string() to a string field carrying its bounds', () => {
    const [field] = zodToDescriptors(z.object({ response: z.string().min(1).max(200) }));

    expect(field?.kind).toBe('string');
    expect(field as StringField).toMatchObject({ minLength: 1, maxLength: 200 });
  });

  test('a registered string becomes a channel picker, not a text box', () => {
    const schema = z.object({
      channel: z
        .string()
        .register(protonFields, { field: 'channel-id', label: 'Announcements', channelTypes: [0] }),
    });

    const [field] = zodToDescriptors(schema);

    expect(field?.kind).toBe('channel-id');
    expect(field?.label).toBe('Announcements');
    expect((field as ChannelIdField).channelTypes).toEqual([0]);
  });

  test('reads metadata registered outside the wrappers too', () => {
    // `.register()` reads naturally either before or after .nullable()/.default(),
    // so both orderings must resolve to the same descriptor.
    const schema = z.object({
      channel: z.string().nullable().default(null).register(protonFields, { field: 'channel-id' }),
    });

    const [field] = zodToDescriptors(schema);

    expect(field?.kind).toBe('channel-id');
    expect(field?.optional).toBe(true);
  });

  test('.optional() marks the field optional', () => {
    const [field] = zodToDescriptors(z.object({ note: z.string().optional() }));

    expect(field?.optional).toBe(true);
  });

  test('.default() carries the default value through', () => {
    const [field] = zodToDescriptors(z.object({ enabled: z.boolean().default(true) }));

    expect(field?.defaultValue).toBe(true);
  });

  test('derives a readable label from the key when none is registered', () => {
    const [field] = zodToDescriptors(z.object({ welcomeMessage: z.string() }));

    expect(field?.label).toBe('Welcome message');
  });

  test('descriptor order follows schema declaration order', () => {
    const schema = z.object({
      first: z.boolean(),
      second: z.string(),
      third: z.boolean(),
    });

    expect(zodToDescriptors(schema).map((f) => f.path)).toEqual(['first', 'second', 'third']);
  });

  test('nests one level of objects into dotted paths', () => {
    const schema = z.object({
      enabled: z.boolean(),
      limits: z.object({ label: z.string(), strict: z.boolean() }),
    });

    expect(zodToDescriptors(schema).map((f) => f.path)).toEqual([
      'enabled',
      'limits.label',
      'limits.strict',
    ]);
  });

  /**
   * These throw at registry build time — when a module is loaded and its own
   * tests run — rather than at render time. The alternative is a blank or broken
   * control appearing in a guild admin's browser with nothing in the logs.
   */
  describe('rejects out-of-scope schemas loudly', () => {
    test('unions are refused', () => {
      const schema = z.object({ mode: z.union([z.string(), z.boolean()]) });

      expect(() => zodToDescriptors(schema)).toThrow(UnsupportedSchemaError);
    });

    test('numbers are refused until the number field type ships', () => {
      expect(() => zodToDescriptors(z.object({ count: z.number() }))).toThrow(
        UnsupportedSchemaError,
      );
    });

    test('two levels of nesting are refused', () => {
      const schema = z.object({
        outer: z.object({ inner: z.object({ deep: z.boolean() }) }),
      });

      expect(() => zodToDescriptors(schema)).toThrow(/one level/);
    });

    test('the error names the offending path', () => {
      const schema = z.object({ nested: z.object({ count: z.number() }) });

      expect(() => zodToDescriptors(schema)).toThrow(/nested\.count/);
    });
  });
});
