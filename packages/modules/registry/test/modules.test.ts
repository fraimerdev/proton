import { describe, expect, test } from 'bun:test';
import { createModuleRegistry, MODULES } from '../src/index.ts';

describe('shipped module registry', () => {
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
