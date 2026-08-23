import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions, zodToDescriptors } from '@proton/core';
import { DELIVER_JOB } from '../src/deliver.ts';
import { createRemindersModule, remindersConfigSchema } from '../src/index.ts';

describe('the reminders manifest', () => {
  test('registers, which is what proves the schedule and its handler line up', () => {
    const registry = new ModuleRegistry();
    registry.register(createRemindersModule());

    expect(registry.maySchedule('reminders', DELIVER_JOB)).toBe(true);
    expect(registry.mayExecute('reminders', 'send')).toBe(true);
    expect(registry.mayExecute('reminders', 'interaction_reply')).toBe(true);
  });

  test('asks to be invited with the permissions delivery actually needs', () => {
    const registry = new ModuleRegistry();
    registry.register(createRemindersModule());

    const invite = registry.invitePermissions();
    expect(invite & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
    expect(invite & Permissions.SendMessages).toBe(Permissions.SendMessages);
  });

  test('both bounds reach the dashboard as duration fields', () => {
    const byPath = new Map(
      zodToDescriptors(remindersConfigSchema).map((field) => [field.path, field.kind]),
    );

    expect(byPath.get('minDuration')).toBe('duration');
    expect(byPath.get('maxDuration')).toBe('duration');
    expect(byPath.get('enabled')).toBe('boolean');
  });
});
