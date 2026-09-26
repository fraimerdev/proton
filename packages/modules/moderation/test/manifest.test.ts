import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions, zodToDescriptors } from '@proton/core';
import {
  liftStoredConfig,
  moderationConfigSchema,
  moderationFormSchema,
  refineModerationWrite,
} from '../src/config.ts';
import { moderationModule } from '../src/index.ts';

describe('moderation manifest', () => {
  test('registers cleanly', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(moderationModule)).not.toThrow();
    expect(registry.get('moderation')?.commands).toHaveLength(8);
  });

  test('ships the three context menus under Apps', () => {
    expect(
      (moderationModule.contextMenus ?? []).map((menu) => [menu.type, menu.name, menu.data.name]),
    ).toEqual([
      ['user', 'Report user', 'Report user'],
      ['message', 'Report message', 'Report message'],
      ['message', 'Punish author', 'Punish author'],
    ]);
  });

  test('reporting is open to every member, punishing from a message is not', () => {
    const menus = new Map((moderationModule.contextMenus ?? []).map((m) => [m.name, m.data]));

    expect(menus.get('Report user')?.default_member_permissions).toBeUndefined();
    expect(menus.get('Report message')?.default_member_permissions).toBeUndefined();
    expect(menus.get('Punish author')?.default_member_permissions).toBe(
      String(Permissions.ModerateMembers),
    );
  });

  test('declares every job it books, each with a handler', () => {
    const handlers = Object.keys(moderationModule.scheduledHandlers ?? {}).sort();

    expect([...(moderationModule.schedules ?? [])].sort()).toEqual(handlers);
    expect(handlers).toEqual([
      'moderation.prompt-cleanup',
      'moderation.report-close',
      'moderation.reports-patrol',
      'moderation.role-run',
      'moderation.timeout',
    ]);
    expect(moderationModule.jobs).toEqual([{ id: 'purge-evidence', cron: '35 * * * *' }]);
  });

  test('declares the events and action kinds reports and punishments use', () => {
    expect(moderationModule.emits).toEqual([
      'moderation.warned',
      'moderation.report_submitted',
      'moderation.report_resolved',
      'moderation.punishment_expired',
    ]);

    for (const kind of ['create_dm', 'delete_message', 'remove_reaction', 'move_member'] as const) {
      expect(moderationModule.actionKinds).toContain(kind);
    }
  });

  test('routes a DM press to the server its custom id names, and only for the DM actions', () => {
    const hook = moderationModule.directInteractionGuild;
    const guild = '100000000000000001';

    expect(hook?.({ moduleId: 'moderation', action: 'rfin', args: [guild, 'abc'] })).toBe(guild);
    expect(hook?.({ moduleId: 'moderation', action: 'rclaim', args: [guild] })).toBeNull();
  });

  test('every manifest listener declares at least one event type', () => {
    for (const listener of moderationModule.listeners ?? []) {
      expect(listener.types.length).toBeGreaterThan(0);
    }
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

  test('every command but /report declares default member permissions', () => {
    for (const command of moderationModule.commands ?? []) {
      if (command.name === 'report') continue;
      expect(command.data.default_member_permissions).toBeTruthy();
    }
  });

  test('/report is open to every member and runs only in a server', () => {
    const report = moderationModule.commands?.find((c) => c.name === 'report');

    expect(report?.data.default_member_permissions ?? null).toBeNull();
    expect(report?.data.contexts).toEqual([0]);
  });

  test('config renders as dashboard fields, including the duration kind', () => {
    const descriptors = zodToDescriptors(moderationFormSchema);
    const byPath = new Map(descriptors.map((d) => [d.path, d]));

    expect(byPath.get('enabled')?.kind).toBe('boolean');
    expect(byPath.get('publicReplies')?.kind).toBe('boolean');
    expect(byPath.get('escalationWindow')?.kind).toBe('duration');
    expect(byPath.has('punish')).toBe(false);
    expect(byPath.has('reports')).toBe(false);
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

  test('punish settings and user reports each own a section', () => {
    expect(
      (moderationModule.dashboard?.sections ?? []).map((section) => [section.id, section.fields]),
    ).toEqual([
      ['general', ['enabled', 'publicReplies']],
      ['escalation', ['escalationWindow', 'escalationLadder']],
      ['punish', ['punish']],
      ['reports', ['reports']],
    ]);
  });

  test('lifts a save that carries no ladder, so a stale page cannot reset it', () => {
    expect(moderationModule.liftStoredConfig).toBe(liftStoredConfig);
  });

  test('checks every save across fields', () => {
    expect(moderationModule.refineWrite).toBe(refineModerationWrite);
  });

  test('needs no privileged intent', () => {
    expect(moderationModule.requiredIntents).toEqual([1]);
  });
});
