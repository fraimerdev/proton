import { describe, expect, test } from 'bun:test';
import { durationStringSchema, protonFields, snowflakeSchema } from '@proton/core';
import { createModuleRegistry } from '../src/index.ts';

// Every module's schema is built at import time, so loading the registry is what makes a stray
// registration visible: register() returns the instance it was handed rather than a copy, and a
// module that registers on a schema the others import writes its own label onto all of their
// fields. Counters did exactly that, and every channel field in every module read "Channel".
describe('a schema shared across modules, once every module has been loaded', () => {
  createModuleRegistry();

  const shared = { snowflakeSchema, durationStringSchema };

  for (const [name, schema] of Object.entries(shared)) {
    test(`${name} carries no module's field metadata`, () => {
      expect(protonFields.get(schema)).toBeUndefined();
    });
  }

  test('cloning first is what keeps a registration local to the module that made it', () => {
    const mine = snowflakeSchema.clone().register(protonFields, { label: 'Mine' });

    expect(protonFields.get(mine)).toEqual({ label: 'Mine' });
    expect(protonFields.get(snowflakeSchema)).toBeUndefined();
  });
});
