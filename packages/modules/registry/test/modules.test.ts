import { describe, expect, test } from 'bun:test';
import { createModuleRegistry, MODULES } from '../src/index.ts';

/**
 * Written out rather than derived from `MODULES`, which is the point: a module
 * dropped from the list — by a bad merge, or by someone "temporarily" commenting
 * one out — fails here instead of shipping a build where a guild admin's
 * settings page silently loses a section.
 */
const SHIPPED_MODULE_IDS = ['ping', 'cases', 'moderation', 'logging', 'permissions'];

describe('shipped module registry', () => {
  test('ships exactly the expected modules', () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual([...SHIPPED_MODULE_IDS].sort());
  });

  /**
   * Registration validates every manifest — defaultConfig against its own schema,
   * and that the dashboard can render it. So this one call is a contract test for
   * every module Proton ships, and a broken manifest fails the build rather than
   * a guild admin's settings page.
   */
  test('every shipped module registers cleanly', () => {
    expect(() => createModuleRegistry()).not.toThrow();
    expect(createModuleRegistry().all()).toHaveLength(MODULES.length);
  });

  test('module ids are unique', () => {
    const ids = MODULES.map((m) => m.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Command names are a single global namespace, in two places that both fail
   * quietly. `ModuleRuntime` resolves the owning module with a `find` over every
   * manifest, so a duplicate dispatches to whichever module happens to be listed
   * first — the other module's command would appear to do nothing. Discord is
   * blunter: the bulk registration PUT rejects the whole set, so no command
   * registers at all.
   */
  test('command names do not collide across modules', () => {
    const owners = new Map<string, string>();

    for (const manifest of MODULES) {
      for (const command of manifest.commands ?? []) {
        expect(owners.get(command.name) ?? manifest.id).toBe(manifest.id);
        owners.set(command.name, manifest.id);
      }
    }
  });

  /**
   * A section naming a field that no longer exists renders as an empty box with
   * a heading. Not every field has a *descriptor* — `cases.escalationLadder` and
   * `permissions.overrides` are claimed by a section but rendered by a bespoke
   * editor (§9) — so this checks against the config schema, which is the thing
   * that actually has to contain them.
   */
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

  /**
   * The invite URL and the gateway Identify bitfield are both computed from
   * manifests (§10.3), so this asserts the aggregate is non-empty rather than
   * silently inviting the bot with no permissions.
   */
  test('aggregate permissions and intents are derived, not hand-written', () => {
    const registry = createModuleRegistry();

    expect(registry.invitePermissions()).toBeGreaterThan(0n);
    expect(registry.requiredIntents()).toBeGreaterThan(0);
  });
});
