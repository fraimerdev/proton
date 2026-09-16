import { describe, expect, test } from 'bun:test';
import { simulationInputDefaults, simulationInputsSchema } from '../../src/simulation/inputs.ts';
import type { SimulationInput } from '../../src/simulation/types.ts';

const INPUTS: SimulationInput[] = [
  { key: 'level', label: 'Level', kind: 'integer', min: 1, max: 100, fallback: 5 },
  { key: 'reason', label: 'Reason', kind: 'text', maxLength: 20, fallback: 'Sorted' },
  {
    key: 'decision',
    label: 'Decision',
    kind: 'choice',
    options: [
      { value: 'approved', label: 'Accepted' },
      { value: 'denied', label: 'Turned down' },
    ],
    fallback: 'approved',
  },
  { key: 'silent', label: 'Silent', kind: 'boolean', fallback: false },
];

describe('simulationInputsSchema', () => {
  const schema = simulationInputsSchema(INPUTS);

  test('fills every declared input from its fallback', () => {
    expect(schema.parse({})).toEqual({
      level: 5,
      reason: 'Sorted',
      decision: 'approved',
      silent: false,
    });
  });

  test('takes the values a dialog sends', () => {
    expect(schema.parse({ level: 9, decision: 'denied', silent: true })).toEqual({
      level: 9,
      reason: 'Sorted',
      decision: 'denied',
      silent: true,
    });
  });

  test('refuses a number outside the bounds the control offers', () => {
    expect(schema.safeParse({ level: 0 }).success).toBe(false);
    expect(schema.safeParse({ level: 101 }).success).toBe(false);
  });

  test('refuses a choice that is not one of the options', () => {
    expect(schema.safeParse({ decision: 'maybe' }).success).toBe(false);
  });

  test('refuses text longer than the field allows', () => {
    expect(schema.safeParse({ reason: 'x'.repeat(21) }).success).toBe(false);
  });

  test('drops a key no simulation declared', () => {
    expect(schema.parse({ smuggled: 'value' })).not.toHaveProperty('smuggled');
  });

  test('defaults match what the dialog renders before anything is touched', () => {
    expect(simulationInputDefaults(INPUTS)).toEqual(schema.parse({}));
  });
});
