import { describe, expect, test } from 'bun:test';
import { DEFAULT_INTENTS } from '@proton/gateway/env';
import { NORMALISED_EVENT_TYPES } from '@proton/gateway/normaliser';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createModuleRegistry, MODULES } from '../src/index.ts';

/**
 * Written out rather than derived from `MODULES`, which is the point: a module
 * dropped from the list — by a bad merge, or by someone "temporarily" commenting
 * one out — fails here instead of shipping a build where a guild admin's
 * settings page silently loses a section.
 */
const SHIPPED_MODULE_IDS = [
  // Phase 0–1.
  'ping',
  'cases',
  'moderation',
  'logging',
  'permissions',
  // Phase 2 (§8): security.
  'antinuke',
  'antiraid',
  'verification',
  'backup',
  'phishing',
  // Phase 3 (§8): engagement.
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

  /**
   * The one place the derivation above is *not* actually derived.
   *
   * `apps/gateway` cannot import this list — it identifies before any module
   * runs, and a gateway that depended on the module graph would redeploy every
   * time a manifest changed, which I13 exists to prevent — so `DEFAULT_INTENTS`
   * is written by hand and the two can drift. The drift is silent in the worst
   * possible way: `registry.evaluate` is told the granted intents and would
   * happily report a module enabled, while the gateway never subscribed to the
   * dispatch it needs, so the module sits in a healthy-looking dashboard
   * receiving an empty stream. Phase 2 hit exactly this — five manifests wanted
   * GUILD_MODERATION for the audit-log dispatch and the constant did not have
   * it yet.
   *
   * A subset check, not equality: the owner may enable an intent ahead of the
   * module that consumes it, and that is not a fault.
   */
  test('every intent a shipped module needs is one the gateway identifies with', () => {
    const needed = createModuleRegistry().requiredIntents();
    const missing = needed & ~DEFAULT_INTENTS;

    // Named, not just counted — `expected 8 to be 0` would send whoever hits
    // this reading bit tables.
    expect(
      Object.entries(GatewayIntentBits)
        .filter(([, bit]) => typeof bit === 'number' && (missing & bit) !== 0)
        .map(([name]) => name),
    ).toEqual([]);
  });

  /**
   * The same class of silent drift as the intents check above, one layer in.
   *
   * `EventType` is the vocabulary a listener is *allowed* to name; the normaliser
   * decides what is ever actually said. Subscribing to a declared-but-unemitted
   * type compiles, registers, evaluates as enabled, and receives nothing —
   * forever, with no error anywhere. It is not a hypothetical: `logging` shipped
   * subscribed to `message.updated`, `message.deleted` and `message.bulk_deleted`
   * and `phishing` to `message.updated`, none of which the normaliser emitted, so
   * every message-edit path in the product was dead and every test passed.
   *
   * This is the guard that makes that a failing unit test. It names the module
   * and the type, because the whole failure mode is not being told.
   */
  test('every listener subscribes to an event something actually emits', () => {
    /**
     * Two producers, not one.
     *
     * The normaliser speaks for Discord. Since Phase 3 a module may also publish,
     * through the `emits` allowlist on its manifest — that is how
     * `xp.level_gained` (§4-P1) exists at all, given that no Discord dispatch
     * corresponds to it. A listener naming a type in neither set can never fire,
     * which is the failure this test exists to catch, so the check is against the
     * union rather than against the gateway alone.
     */
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

  /**
   * A listener with no types is a subscription to nothing — `bus.subscribe` with
   * an empty array creates no consumer groups and blocks forever. Cheap to
   * assert, and it would otherwise look identical to a quiet guild.
   */
  test('no listener declares an empty type list', () => {
    const empty = MODULES.filter((manifest) =>
      (manifest.listeners ?? []).some((listener) => listener.types.length === 0),
    ).map((manifest) => manifest.id);

    expect(empty).toEqual([]);
  });
});
