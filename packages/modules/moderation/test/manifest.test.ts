import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, zodToDescriptors } from '@proton/core';
import { moderationConfigSchema } from '../src/config.ts';
import { moderationModule } from '../src/index.ts';

describe('moderation manifest', () => {
  /**
   * Registration checks the default config against the schema and that the
   * dashboard can render every field, so this one call is the module's contract
   * test — a broken manifest fails here rather than on an admin's settings page.
   */
  test('registers cleanly', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(moderationModule)).not.toThrow();
    expect(registry.get('moderation')?.commands).toHaveLength(9);
  });

  test('command names match their registration payloads', () => {
    for (const command of moderationModule.commands ?? []) {
      expect(command.data.name).toBe(command.name);
      expect(command.data.description.length).toBeGreaterThan(0);
    }
  });

  test('command names are unique', () => {
    const names = (moderationModule.commands ?? []).map((c) => c.name);

    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * Discord hides a command from members who lack the permission it declares.
   * A moderation command without one is offered to everybody.
   */
  test('every command declares default member permissions', () => {
    for (const command of moderationModule.commands ?? []) {
      expect(command.data.default_member_permissions).toBeTruthy();
    }
  });

  test('config renders as dashboard fields, including the duration kind', () => {
    const descriptors = zodToDescriptors(moderationConfigSchema);
    const byPath = new Map(descriptors.map((d) => [d.path, d]));

    expect(byPath.get('defaultTimeoutDuration')?.kind).toBe('duration');
    expect(byPath.get('defaultBanDeleteDays')?.kind).toBe('number');
    expect(byPath.get('requireReason')?.kind).toBe('boolean');
  });

  /** Every field a section claims must exist, or the form silently drops it. */
  test('dashboard sections name real config fields', () => {
    const paths = new Set(zodToDescriptors(moderationConfigSchema).map((d) => d.path));
    const claimed = (moderationModule.dashboard?.sections ?? []).flatMap((s) => s.fields);

    for (const field of claimed) expect(paths).toContain(field);
    expect(new Set(claimed).size).toBe(paths.size);
  });

  test('needs no privileged intent', () => {
    // 1 << 0 is GUILDS, the only non-privileged intent commands require.
    expect(moderationModule.requiredIntents).toEqual([1]);
  });
});
