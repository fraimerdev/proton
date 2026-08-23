import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { zodToDescriptors } from '../../src/config/descriptor.ts';
import { CORE_MODULE_ID, CORE_PROVIDER_IDS } from '../../src/providers/builtins.ts';
import {
  PROVIDER_BUILDER_MAX,
  ProviderRegistrationError,
  ProviderRegistry,
} from '../../src/providers/registry.ts';
import type { ConditionProvider } from '../../src/providers/types.ts';
import { availability, countingCondition, GUILD } from './harness.ts';

function wideSchema(fields: number) {
  const shape: Record<string, z.ZodType> = {};
  for (let index = 0; index < fields; index += 1) {
    shape[`field${index}`] = z.string().default('');
  }
  return z.object(shape);
}

describe('ProviderRegistry registration', () => {
  test('the core builtins are registered without any module doing it', () => {
    const registry = new ProviderRegistry();

    for (const id of CORE_PROVIDER_IDS) {
      expect(registry.condition(id)).toBeDefined();
    }
  });

  test('rejects a duplicate provider id across two modules', () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'leveling',
      providers: [countingCondition('leveling.level', 'leveling').provider],
    });

    const clash = countingCondition('leveling.level', 'leveling').provider;

    expect(() => registry.register({ id: 'leveling', providers: [clash] })).toThrow(
      ProviderRegistrationError,
    );
  });

  test('rejects an id that is not namespaced to the registering module', () => {
    const registry = new ProviderRegistry();
    const stolen = countingCondition('leveling.level', 'leveling').provider;

    expect(() => registry.register({ id: 'giveaways', providers: [stolen] })).toThrow(
      /may only register its own providers/,
    );
  });

  test('rejects an id with the right moduleId but the wrong namespace', () => {
    const registry = new ProviderRegistry();
    const misnamed = countingCondition('level', 'leveling').provider;

    expect(() => registry.register({ id: 'leveling', providers: [misnamed] })).toThrow(
      /must be namespaced/,
    );
  });

  test(`rejects a builder wider than the ${PROVIDER_BUILDER_MAX}-component modal limit`, () => {
    const registry = new ProviderRegistry();
    const schema = wideSchema(PROVIDER_BUILDER_MAX + 1);

    const provider: ConditionProvider<typeof schema> = {
      kind: 'condition',
      id: 'leveling.wide',
      moduleId: 'leveling',
      label: 'Wide',
      description: 'too many fields for one modal',
      configSchema: schema,
      builder: zodToDescriptors(schema),
      cost: 'facts',
      async evaluate() {
        return { passed: true };
      },
      describe() {
        return '';
      },
      describeFailure() {
        return '';
      },
    };

    expect(() =>
      registry.register({ id: 'leveling', providers: [provider as unknown as ConditionProvider] }),
    ).toThrow(/at most 5/);
  });

  test('accepts a builder exactly at the modal limit', () => {
    const registry = new ProviderRegistry();
    const schema = wideSchema(PROVIDER_BUILDER_MAX);

    const provider: ConditionProvider<typeof schema> = {
      kind: 'condition',
      id: 'leveling.exact',
      moduleId: 'leveling',
      label: 'Exact',
      description: 'exactly five fields',
      configSchema: schema,
      builder: zodToDescriptors(schema),
      cost: 'facts',
      async evaluate() {
        return { passed: true };
      },
      describe() {
        return '';
      },
      describeFailure() {
        return '';
      },
    };

    expect(() =>
      registry.register({ id: 'leveling', providers: [provider as unknown as ConditionProvider] }),
    ).not.toThrow();
  });

  test('rejects a builder field that is not in the config schema', () => {
    const registry = new ProviderRegistry();
    const schema = z.object({ min: z.number().default(0) });

    const provider: ConditionProvider<typeof schema> = {
      kind: 'condition',
      id: 'leveling.stray',
      moduleId: 'leveling',
      label: 'Stray',
      description: 'builder describes a field the schema does not have',
      configSchema: schema,
      builder: [{ kind: 'number', path: 'window', label: 'Window', optional: false }],
      cost: 'facts',
      async evaluate() {
        return { passed: true };
      },
      describe() {
        return '';
      },
      describeFailure() {
        return '';
      },
    };

    expect(() =>
      registry.register({ id: 'leveling', providers: [provider as unknown as ConditionProvider] }),
    ).toThrow(/not in its configSchema/);
  });

  test('rejects a query-backed provider with no batchEvaluate', () => {
    const registry = new ProviderRegistry();
    const provider = countingCondition('leveling.slow', 'leveling', {
      cost: 'query',
      batch: false,
    }).provider;

    expect(() => registry.register({ id: 'leveling', providers: [provider] })).toThrow(
      /one query at a time/,
    );
  });

  test('accepts a query-backed provider that can answer for a batch', () => {
    const registry = new ProviderRegistry();
    const provider = countingCondition('leveling.fast', 'leveling', { cost: 'query' }).provider;

    expect(() => registry.register({ id: 'leveling', providers: [provider] })).not.toThrow();
  });
});

describe('ProviderRegistry lookup', () => {
  test('condition() does not return a multiplier and vice versa', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'leveling',
      providers: [countingCondition('leveling.level', 'leveling').provider],
    });

    expect(registry.condition('leveling.level')).toBeDefined();
    expect(registry.multiplier('leveling.level')).toBeUndefined();
  });

  test('parseConfig names the provider when its stored settings are invalid', () => {
    const registry = new ProviderRegistry();
    const parsed = registry.parseConfig('core.has_role', { roleIds: [] });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.humanReason).toContain('Has a role');
  });

  test('parseConfig on an unloaded provider says the owning module is not running', () => {
    const registry = new ProviderRegistry();
    const parsed = registry.parseConfig('leveling.level', { min: 5 });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.humanReason).toContain('not running');
  });
});

describe('listAvailable', () => {
  test('omits providers whose owning module is switched off for that guild', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'leveling',
      providers: [countingCondition('leveling.level', 'leveling').provider],
    });
    registry.register({
      id: 'cases',
      providers: [countingCondition('cases.no_active_case', 'cases').provider],
    });

    const listed = await registry.listAvailable(
      GUILD,
      availability({ leveling: true, cases: false }),
    );
    const ids = listed.map((provider) => provider.id);

    expect(ids).toContain('leveling.level');
    expect(ids).not.toContain('cases.no_active_case');
  });

  test('core builtins stay available even when every module is off', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'leveling',
      providers: [countingCondition('leveling.level', 'leveling').provider],
    });

    const listed = await registry.listAvailable(GUILD, availability({}));
    const ids = listed.map((provider) => provider.id);

    expect(ids).toEqual([...CORE_PROVIDER_IDS].sort());
    expect(listed.every((provider) => provider.moduleId === CORE_MODULE_ID)).toBe(true);
  });

  test('asks each owning module exactly once, not once per provider', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'leveling',
      providers: [
        countingCondition('leveling.level', 'leveling').provider,
        countingCondition('leveling.xp', 'leveling').provider,
        countingCondition('leveling.messages', 'leveling').provider,
      ],
    });

    const asked: string[] = [];
    await registry.listAvailable(GUILD, {
      async isEnabled(_guildId, moduleId) {
        asked.push(moduleId);
        return true;
      },
    });

    expect(asked).toEqual(['leveling']);
  });
});
