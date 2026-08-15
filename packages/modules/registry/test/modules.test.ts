import { describe, expect, test } from 'bun:test';
import { DEFAULT_INTENTS } from '@proton/gateway/env';
import { NORMALISED_EVENT_TYPES } from '@proton/gateway/normaliser';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createModuleRegistry, MODULES } from '../src/index.ts';

const SHIPPED_MODULE_IDS = [
  'ping',
  'cases',
  'moderation',
  'logging',
  'permissions',

  'antinuke',
  'antiraid',
  'verification',
  'backup',
  'phishing',

  'leveling',
  'autorole',
  'rolemenu',
  'starboard',
  'welcome',
];

describe('shipped module registry', () => {
  test('ships exactly the expected modules', () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual([...SHIPPED_MODULE_IDS].sort());
  });

  test('every shipped module registers cleanly', () => {
    expect(() => createModuleRegistry()).not.toThrow();
    expect(createModuleRegistry().all()).toHaveLength(MODULES.length);
  });

  test('module ids are unique', () => {
    const ids = MODULES.map((m) => m.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  test('command names do not collide across modules', () => {
    const owners = new Map<string, string>();

    for (const manifest of MODULES) {
      for (const command of manifest.commands ?? []) {
        expect(owners.get(command.name) ?? manifest.id).toBe(manifest.id);
        owners.set(command.name, manifest.id);
      }
    }
  });

  test('dashboard sections only claim fields the config schema defines', () => {
    for (const manifest of MODULES) {
      const keys = new Set(Object.keys(manifest.configSchema.shape));

      for (const section of manifest.dashboard?.sections ?? []) {
        for (const field of section.fields) {
          expect({ module: manifest.id, section: section.id, field }).toEqual({
            module: manifest.id,
            section: section.id,
            field: keys.has(field) ? field : `unknown config field '${field}'`,
          });
        }
      }
    }
  });

  test('every module declares at least one required permission', () => {
    for (const manifest of MODULES) {
      expect(manifest.requiredPermissions.length).toBeGreaterThan(0);
    }
  });

  test('every declared dependency is itself a shipped module', () => {
    const ids = new Set(MODULES.map((m) => m.id));

    for (const manifest of MODULES) {
      for (const dependency of manifest.dependsOn ?? []) {
        expect(ids).toContain(dependency);
      }
    }
  });

  test('aggregate permissions and intents are derived, not hand-written', () => {
    const registry = createModuleRegistry();

    expect(registry.invitePermissions()).toBeGreaterThan(0n);
    expect(registry.requiredIntents()).toBeGreaterThan(0);
  });

  test('every intent a shipped module needs is one the gateway identifies with', () => {
    const needed = createModuleRegistry().requiredIntents();
    const missing = needed & ~DEFAULT_INTENTS;

    expect(
      Object.entries(GatewayIntentBits)
        .filter(([, bit]) => typeof bit === 'number' && (missing & bit) !== 0)
        .map(([name]) => name),
    ).toEqual([]);
  });

  test('every listener subscribes to an event something actually emits', () => {
    const emitted = new Set<string>([
      ...NORMALISED_EVENT_TYPES,
      ...MODULES.flatMap((manifest) => manifest.emits ?? []),
    ]);

    const dead = MODULES.flatMap((manifest) =>
      (manifest.listeners ?? []).flatMap((listener) =>
        listener.types
          .filter((type) => !emitted.has(type))
          .map((type) => `${manifest.id} listens for '${type}', which nothing emits`),
      ),
    );

    expect(dead).toEqual([]);
  });

  test('no listener declares an empty type list', () => {
    const empty = MODULES.filter((manifest) =>
      (manifest.listeners ?? []).some((listener) => listener.types.length === 0),
    ).map((manifest) => manifest.id);

    expect(empty).toEqual([]);
  });
});
