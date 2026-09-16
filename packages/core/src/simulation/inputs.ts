import { z } from 'zod';
import type { SimulationInput } from './types.ts';

export type SimulationInputValue = string | number | boolean;

function schemaFor(input: SimulationInput): z.ZodType<SimulationInputValue> {
  switch (input.kind) {
    case 'integer':
      return z.number().int().min(input.min).max(input.max);
    case 'text':
      return z.string().max(input.maxLength);
    case 'choice':
      return z.enum(input.options.map((option) => option.value) as [string, ...string[]]);
    case 'boolean':
      return z.boolean();
  }
}

/**
 * Derived from the declared inputs rather than written twice: the dialog draws its controls from
 * the same list, so a bound that only lived in the schema would be a control that lets an admin
 * pick a value the backend then refuses.
 */
export function simulationInputsSchema(
  inputs: readonly SimulationInput[],
): z.ZodType<Record<string, SimulationInputValue>> {
  const shape = Object.fromEntries(
    inputs.map((input) => [input.key, schemaFor(input).default(input.fallback)]),
  );

  return z.object(shape).strip() as unknown as z.ZodType<Record<string, SimulationInputValue>>;
}

export function simulationInputDefaults(
  inputs: readonly SimulationInput[],
): Record<string, SimulationInputValue> {
  return Object.fromEntries(inputs.map((input) => [input.key, input.fallback]));
}

export function readInteger(
  inputs: Readonly<Record<string, SimulationInputValue>>,
  key: string,
  fallback: number,
): number {
  const value = inputs[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function readText(
  inputs: Readonly<Record<string, SimulationInputValue>>,
  key: string,
  fallback: string,
): string {
  const value = inputs[key];
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

export function readChoice<T extends string>(
  inputs: Readonly<Record<string, SimulationInputValue>>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = inputs[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function readBoolean(
  inputs: Readonly<Record<string, SimulationInputValue>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = inputs[key];
  return typeof value === 'boolean' ? value : fallback;
}
