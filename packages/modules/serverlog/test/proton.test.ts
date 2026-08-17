import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { AuditLogEvent } from 'discord-api-types/v10';
import { ServerLogColors } from '../src/colours.ts';
import { serverlogDefaultConfig } from '../src/config.ts';
import { createServerlogListener } from '../src/listeners.ts';
import { colourForKind } from '../src/render/proton.ts';
import {
  ACTOR,
  auditEvent,
  BOT_USER,
  config,
  context,
  EMOJIS,
  GUILD,
  RecordingExecutor,
  resolver,
} from './harness.ts';

const listener = () =>
  createServerlogListener({ emojis: EMOJIS, users: resolver, botUserId: BOT_USER });

function protonEvent(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return { id: `${type}:1`, type, guildId: GUILD, occurredAt: 1_700_000_000_000, payload };
}

const CONFIG_CHANGED = {
  auditId: 'audit-1',
  guildId: GUILD,
  moduleId: 'joinroles',
  moduleName: 'Join Roles',
  actorId: ACTOR,
  source: 'dashboard' as const,
  enabledBefore: true,
  enabledAfter: true,
  changedKeys: ['memberRoleIds', 'botRoleIds'],
};

describe('config changes', () => {
  test('a settings change names the module, the admin and which settings', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.config_changed', CONFIG_CHANGED),
      context(executor),
    );

    expect(executor.titles()).toEqual(['Join Roles settings changed']);

    const description = String(executor.embeds()[0]?.description);
    expect(description).toContain('joinroles');
    expect(description).toContain('dashboard');

    const fields = executor.embeds()[0]?.fields as Array<{ value: string }>;
    expect(fields[0]?.value).toContain('memberRoleIds');
  });

  test('config values are never in the embed, only the keys that changed', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.config_changed', {
        ...CONFIG_CHANGED,
        changedKeys: ['memberRoleIds'],
      }),
      context(executor),
    );

    expect(JSON.stringify(executor.embeds()[0])).not.toContain('700000000000000001');
  });

  test('switching a module on is its own log, not a settings change', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.config_changed', {
        ...CONFIG_CHANGED,
        enabledBefore: false,
        enabledAfter: true,
        changedKeys: [],
      }),
      context(executor),
    );

    expect(executor.titles()).toEqual(['Join Roles switched on']);
  });

  test('a save that toggled and changed settings logs both', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.config_changed', { ...CONFIG_CHANGED, enabledBefore: false }),
      context(executor),
    );

    expect(executor.titles().sort()).toEqual([
      'Join Roles settings changed',
      'Join Roles switched on',
    ]);
  });
});

describe('actions Proton took', () => {
  const BAN = {
    caseId: 'case-1',
    guildId: GUILD,
    moduleId: 'moderation',
    kind: 'ban' as const,
    actorId: ACTOR,
    targetId: '100000000000000007',
    reason: 'raid account',
    dryRun: false,
    expiresAt: null,
  };

  test('a ban is logged with its case id and reason', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(protonEvent('proton.action_executed', BAN), context(executor));

    expect(executor.titles()).toEqual(['Proton ban']);

    const description = String(executor.embeds()[0]?.description);
    expect(description).toContain('case-1');
    expect(description).toContain('raid account');
  });

  test('a module actor is named without pretending to be a user', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.action_executed', { ...BAN, actorId: 'proton:antinuke' }),
      context(executor),
    );

    expect(String(executor.embeds()[0]?.description)).toContain('antinuke');
    expect(String(executor.embeds()[0]?.description)).not.toContain('<@proton:');
  });

  test('the colour follows what the action did', () => {
    expect(colourForKind('ban')).toBe(ServerLogColors.Remove);
    expect(colourForKind('unban')).toBe(ServerLogColors.Add);
    expect(colourForKind('timeout')).toBe(ServerLogColors.Modify);
  });
});

describe('security trips', () => {
  test('an anti-nuke trip names what happened and what was done', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.security_tripped', {
        guildId: GUILD,
        moduleId: 'antinuke',
        trigger: 'channelDelete',
        actorId: ACTOR,
        summary: 'four channels were deleted in ten seconds',
        actionsTaken: ['stripped role 700000000000000001', 'ban'],
        ownerExempt: false,
      }),
      context(executor),
    );

    expect(executor.titles()).toEqual(['Anti-nuke tripped']);
    expect(String(executor.embeds()[0]?.description)).toContain('four channels');
  });

  test('an owner-exempt trip says so rather than looking like it worked', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.security_tripped', {
        guildId: GUILD,
        moduleId: 'antinuke',
        trigger: 'channelDelete',
        actorId: ACTOR,
        summary: 'the actor owns this server',
        actionsTaken: [],
        ownerExempt: true,
      }),
      context(executor),
    );

    expect(String(executor.embeds()[0]?.description)).toContain('owner was exempt');
  });
});

describe('Proton’s own audit entries are not logged twice', () => {
  test('a ban Proton performed is logged once, from the Proton event', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      auditEvent(AuditLogEvent.MemberBanAdd, {
        user_id: BOT_USER,
        target_id: '100000000000000007',
      }),
      context(executor),
    );

    expect(executor.requests).toEqual([]);
  });

  test('a ban a human performed still logs from the audit entry', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      auditEvent(AuditLogEvent.MemberKick, { target_id: '100000000000000007' }),
      context(executor),
    );

    expect(executor.titles()).toEqual(['Member kicked']);
  });
});

describe('the Proton category can be switched off', () => {
  test('nothing is logged when the category is off', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.config_changed', CONFIG_CHANGED),
      context(
        executor,
        config({ categories: { ...serverlogDefaultConfig.categories, proton: false } }),
      ),
    );

    expect(executor.requests).toEqual([]);
  });
});
