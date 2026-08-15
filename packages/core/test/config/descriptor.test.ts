import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type ChannelIdField,
  type EnumField,
  type NumberField,
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

  test('maps z.number() to a number field carrying its bounds', () => {
    const [field] = zodToDescriptors(z.object({ threshold: z.number().min(1).max(20) }));

    expect(field?.kind).toBe('number');
    expect(field as NumberField).toMatchObject({ min: 1, max: 20, path: 'threshold' });
  });

  test('an unbounded number carries no bounds', () => {
    const [field] = zodToDescriptors(z.object({ weight: z.number() }));

    expect(field as NumberField).toEqual({
      kind: 'number',
      path: 'weight',
      label: 'Weight',
      optional: false,
    });
  });

  test('.int() does not leak the safe-integer range as a form bound', () => {
    // Zod encodes `.int()` as ±MAX_SAFE_INTEGER; surfacing that as a spinner
    // capped at 9007199254740991 would read as a bug to a guild admin.
    const [field] = zodToDescriptors(z.object({ strikes: z.number().int().min(1) }));

    expect(field as NumberField).toMatchObject({ kind: 'number', min: 1 });
    expect((field as NumberField).max).toBeUndefined();
  });

  test('maps z.enum() to an enum field carrying its options in order', () => {
    const [field] = zodToDescriptors(z.object({ mode: z.enum(['off', 'warn', 'ban']) }));

    expect(field?.kind).toBe('enum');
    expect((field as EnumField).options).toEqual(['off', 'warn', 'ban']);
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

  test('a string registered as role-id becomes a role picker', () => {
    const schema = z.object({
      muteRole: z.string().register(protonFields, { field: 'role-id' }),
    });

    const [field] = zodToDescriptors(schema);

    expect(field).toMatchObject({ kind: 'role-id', path: 'muteRole', label: 'Mute role' });
  });

  test('a string registered as duration becomes a duration field', () => {
    const schema = z.object({
      timeout: z.string().default('30m').register(protonFields, { field: 'duration' }),
    });

    const [field] = zodToDescriptors(schema);

    expect(field).toMatchObject({ kind: 'duration', path: 'timeout', defaultValue: '30m' });
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

  describe('flat arrays', () => {
    test('an array of strings is the string kind, marked as an array', () => {
      const [field] = zodToDescriptors(z.object({ keywords: z.array(z.string().max(50)) }));

      expect(field).toMatchObject({ kind: 'string', array: true, path: 'keywords' });
      expect(field as StringField).toMatchObject({ maxLength: 50 });
    });

    test('a scalar field is not marked as an array', () => {
      const [field] = zodToDescriptors(z.object({ keyword: z.string() }));

      expect(field?.array).toBeUndefined();
    });

    test('the element kind hint is honoured', () => {
      const schema = z.object({
        staffRoles: z.array(z.string().register(protonFields, { field: 'role-id' })),
      });

      const [field] = zodToDescriptors(schema);

      expect(field).toMatchObject({ kind: 'role-id', array: true });
    });

    test('a hint registered on the array itself is honoured too', () => {
      const schema = z.object({
        logChannels: z
          .array(z.string())
          .register(protonFields, { field: 'channel-id', label: 'Log channels' }),
      });

      const [field] = zodToDescriptors(schema);

      expect(field).toMatchObject({ kind: 'channel-id', array: true, label: 'Log channels' });
    });

    test('arrays of numbers and enums work', () => {
      const schema = z.object({
        levels: z.array(z.number().min(0)),
        modes: z.array(z.enum(['off', 'on'])),
      });

      const [levels, modes] = zodToDescriptors(schema);

      expect(levels).toMatchObject({ kind: 'number', array: true, min: 0 });
      expect(modes).toMatchObject({ kind: 'enum', array: true, options: ['off', 'on'] });
    });

    test('an array default carries through', () => {
      const [field] = zodToDescriptors(z.object({ keywords: z.array(z.string()).default([]) }));

      expect(field?.defaultValue).toEqual([]);
      expect(field?.array).toBe(true);
    });
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

    test('discriminated unions are refused', () => {
      const schema = z.object({
        action: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('ban') }),
          z.object({ kind: z.literal('kick') }),
        ]),
      });

      expect(() => zodToDescriptors(schema)).toThrow(UnsupportedSchemaError);
    });

    test('types outside the v1 vocabulary are refused', () => {
      expect(() => zodToDescriptors(z.object({ when: z.date() }))).toThrow(UnsupportedSchemaError);
    });

    test('two levels of nesting are refused', () => {
      const schema = z.object({
        outer: z.object({ inner: z.object({ deep: z.boolean() }) }),
      });

      expect(() => zodToDescriptors(schema)).toThrow(/one level/);
    });

    test('the error names the offending path', () => {
      const schema = z.object({ nested: z.object({ when: z.date() }) });

      expect(() => zodToDescriptors(schema)).toThrow(/nested\.when/);
    });

    test('nested arrays are refused', () => {
      const schema = z.object({ grid: z.array(z.array(z.string())) });

      expect(() => zodToDescriptors(schema)).toThrow(/flat/);
    });

    test('arrays of objects are refused', () => {
      const schema = z.object({ tiers: z.array(z.object({ level: z.number() })) });

      expect(() => zodToDescriptors(schema)).toThrow(/flat/);
    });

    test('numeric enums are refused', () => {
      // Stored as bare numbers in JSONB, a numeric enum makes every guild's
      // config depend on the declaration order of a TypeScript enum.
      enum Level {
        Low = 1,
        High = 2,
      }

      expect(() => zodToDescriptors(z.object({ level: z.enum(Level) }))).toThrow(/string values/);
    });

    test('a kind hint that contradicts its Zod type is refused', () => {
      const schema = z.object({
        enabled: z.boolean().register(protonFields, { field: 'channel-id' }),
      });

      expect(() => zodToDescriptors(schema)).toThrow(/channel-id/);
    });

    test('a duration default the runtime parser rejects is refused', () => {
      const schema = z.object({
        timeout: z.string().default('30 minutes').register(protonFields, { field: 'duration' }),
      });

      expect(() => zodToDescriptors(schema)).toThrow(UnsupportedSchemaError);
      expect(() => zodToDescriptors(schema)).toThrow(/not a valid duration/);
    });

    test('a duration default inside an array is validated element by element', () => {
      const schema = z.object({
        ladder: z
          .array(z.string())
          .default(['10m', 'forever'])
          .register(protonFields, { field: 'duration' }),
      });

      expect(() => zodToDescriptors(schema)).toThrow(/forever/);
    });
  });
});
