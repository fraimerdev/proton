import { describe, expect, test } from 'bun:test';
import {
  type ModuleManifest,
  ModuleRegistry,
  requiredPermissionsFor,
  ruleDefinitionSchema,
} from '@proton/core';
import { casesDefaultConfig } from '../src/config.ts';
import { casesPresetRules, escalationRules } from '../src/escalation.ts';
import { casesModule } from '../src/index.ts';

describe('warn escalation as preset rules', () => {
  test('every preset rule is a valid rule definition', () => {
    // Presets and rules a guild admin builds are the same shape (§4-P2), so they
    // are held to the same schema — a preset that only the module understands
    // could never be inspected, diffed or overridden in the dashboard.
    for (const rule of casesPresetRules) {
      const result = ruleDefinitionSchema.safeParse(rule);

      expect(result.success).toBe(true);
    }
  });

  test('escalation triggers on the internal moderation.warned event', () => {
    for (const rule of casesPresetRules) {
      expect(rule.trigger).toEqual({ kind: 'event', event: 'moderation.warned' });
    }
  });

  test('one rule per rung, counting to that rung’s warning count', () => {
    const rules = escalationRules({
      escalationWindow: '7d',
      escalationLadder: [
        { atWarnings: 2, action: 'timeout', duration: '10m' },
        { atWarnings: 4, action: 'kick' },
        { atWarnings: 6, action: 'ban' },
      ],
    });

    expect(rules.map((r) => r.id)).toEqual(['escalate-at-2', 'escalate-at-4', 'escalate-at-6']);
    expect(rules.map((r) => r.conditions[0])).toEqual([
      { kind: 'rate-over-window', limit: 2, window: '7d' },
      { kind: 'rate-over-window', limit: 4, window: '7d' },
      { kind: 'rate-over-window', limit: 6, window: '7d' },
    ]);
  });

  test('a rung’s duration becomes the action’s duration', () => {
    const [rule] = escalationRules({
      escalationWindow: '30d',
      escalationLadder: [{ atWarnings: 3, action: 'timeout', duration: '1h' }],
    });

    expect(rule?.actions[0]).toMatchObject({ kind: 'timeout', duration: '1h' });
  });

  /**
   * `exactOptionalPropertyTypes` means an absent duration must be absent, not
   * `undefined` — a `duration: undefined` key survives JSON.stringify as a
   * missing key but reads as present to anything checking `'duration' in action`.
   */
  test('a rung with no duration emits no duration key at all', () => {
    const [rule] = escalationRules({
      escalationWindow: '30d',
      escalationLadder: [{ atWarnings: 3, action: 'ban' }],
    });

    expect(rule?.actions[0] && 'duration' in rule.actions[0]).toBe(false);
  });

  test('every rule names why it fired, for Discord’s own audit log', () => {
    for (const rule of casesPresetRules) {
      expect(rule.actions[0]?.reason).toMatch(/automatic escalation/);
    }
  });

  test('priorities ascend with the ladder so ordering is deterministic', () => {
    const priorities = casesPresetRules.map((r) => r.priority);

    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  /**
   * A second rate condition would share the first one's counter — the schema
   * refuses it, and this asserts the compiler never produces one.
   */
  test('each rule carries exactly one rate condition', () => {
    for (const rule of casesPresetRules) {
      expect(rule.conditions.filter((c) => c.kind === 'rate-over-window')).toHaveLength(1);
    }
  });

  test('a guild that clears its ladder gets no escalation rules', () => {
    expect(escalationRules({ escalationWindow: '30d', escalationLadder: [] })).toEqual([]);
  });

  test('the manifest ships the compiled default ladder', () => {
    expect(casesModule.rules).toEqual(escalationRules(casesDefaultConfig));
  });
});

describe('cases manifest', () => {
  /**
   * The permission-failure path for this module is a *rung* the bot cannot
   * perform, not the module itself. `requiredPermissions` is a hard gate — the
   * registry disables a module outright when one is missing — so listing
   * BanMembers there would take a guild's moderation history away because it
   * never grants bans. Each rung's permission is checked by the executor's
   * prechecks instead, which name what is missing and where (I8).
   */
  test('a ladder action’s permission is not a module-wide requirement', () => {
    const rungPermissions = escalationRules({
      escalationWindow: '30d',
      escalationLadder: [{ atWarnings: 3, action: 'ban' }],
    }).map((rule) => requiredPermissionsFor(rule.actions[0]?.kind ?? 'send'));

    expect(rungPermissions[0]).toBeGreaterThan(0n);
    for (const permission of rungPermissions) {
      expect(casesModule.requiredPermissions).not.toContain(permission);
    }
  });

  test('declares at least one permission and a non-privileged intent', () => {
    expect(casesModule.requiredPermissions.length).toBeGreaterThan(0);
    expect(casesModule.requiredIntents.length).toBeGreaterThan(0);
  });

  /**
   * Registration is what proves the §9 boundary is survivable: the ladder stays
   * in config, the generator still refuses it, and the module ships anyway
   * because the manifest names the narrower schema its form comes from. If
   * `formSchema` were dropped, this throws rather than silently rendering the
   * ladder as something it is not.
   */
  test('registers cleanly, and its generated form omits the ladder', () => {
    const registry = new ModuleRegistry();
    registry.register(casesModule as ModuleManifest);

    const paths = registry.descriptors(casesModule.id).map((d) => d.path);

    expect(paths).toEqual(['enabled', 'historyLimit', 'escalationWindow']);
    expect(paths).not.toContain('escalationLadder');
  });
});
