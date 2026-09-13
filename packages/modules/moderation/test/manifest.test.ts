import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, zodToDescriptors } from '@proton/core';
import { liftStoredConfig, moderationConfigSchema, moderationFormSchema } from '../src/config.ts';
import { moderationModule } from '../src/index.ts';

describe('moderation manifest', () => {
  test('registers cleanly', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(moderationModule)).not.toThrow();
    expect(registry.get('moderation')?.commands).toHaveLength(7);
  });

  test('command names match their registration payloads', () => {
    for (const command of moderationModule.commands ?? []) {
      expect(command.data.name).toBe(command.name);
      expect(command.data.description.length).toBeGreaterThan(0);
    }
  });

  test.each(['ban', 'timeout', 'warn', 'lockdown'])(
    '%s carries its lift as a subcommand rather than a second command',
    (name) => {
      const command = moderationModule.commands?.find((c) => c.name === name);

      expect((command?.data.options ?? []).map((o) => o.name)).toEqual(['add', 'remove']);
    },
  );

  test('the commands an add/remove pair replaced are gone', () => {
    const names = new Set((moderationModule.commands ?? []).map((c) => c.name));

    for (const retired of ['unban', 'untimeout', 'unwarn', 'unlock']) {
      expect(`${retired} registered: ${names.has(retired)}`).toBe(`${retired} registered: false`);
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
    const descriptors = zodToDescriptors(moderationFormSchema);
    const byPath = new Map(descriptors.map((d) => [d.path, d]));

    expect(byPath.get('defaultTimeoutDuration')?.kind).toBe('duration');
    expect(byPath.get('defaultBanDeleteDays')?.kind).toBe('number');
    expect(byPath.get('requireReason')?.kind).toBe('boolean');
    expect(byPath.get('escalationWindow')?.kind).toBe('duration');
  });

  test('dashboard sections place every config field exactly once', () => {
    const claimed = (moderationModule.dashboard?.sections ?? []).flatMap((s) => s.fields);

    expect([...claimed].sort()).toEqual(Object.keys(moderationConfigSchema.shape).sort());
  });

  test('the ladder gets its own section, since the generated form cannot draw it', () => {
    expect(moderationModule.dashboard?.sections.find((s) => s.id === 'escalation')).toEqual({
      id: 'escalation',
      title: 'Warn escalation',
      fields: ['escalationWindow', 'escalationLadder'],
    });
  });

  test('lifts a save that carries no ladder, so a stale page cannot reset it', () => {
    expect(moderationModule.liftStoredConfig).toBe(liftStoredConfig);
  });

  test('needs no privileged intent', () => {
    expect(moderationModule.requiredIntents).toEqual([1]);
  });
});
