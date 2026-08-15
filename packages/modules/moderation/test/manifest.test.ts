import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, zodToDescriptors } from '@proton/core';
import { moderationConfigSchema } from '../src/config.ts';
import { moderationModule } from '../src/index.ts';

describe('moderation manifest', () => {
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

  test('dashboard sections name real config fields', () => {
    const paths = new Set(zodToDescriptors(moderationConfigSchema).map((d) => d.path));
    const claimed = (moderationModule.dashboard?.sections ?? []).flatMap((s) => s.fields);

    for (const field of claimed) expect(paths).toContain(field);
    expect(new Set(claimed).size).toBe(paths.size);
  });

  test('needs no privileged intent', () => {
    expect(moderationModule.requiredIntents).toEqual([1]);
  });
});
