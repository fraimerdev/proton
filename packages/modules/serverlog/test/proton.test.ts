import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { AuditLogEvent } from 'discord-api-types/v10';
import { specByKey } from '../src/catalogue.ts';
import { ServerLogColors } from '../src/colours.ts';
import { serverlogDefaultConfig } from '../src/config.ts';
import { createServerlogListener, SERVERLOG_EVENT_TYPES } from '../src/listeners.ts';
import { colourForKind, renderActionExecuted } from '../src/render/proton.ts';
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
  moduleName: 'Join roles',
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

    expect(executor.titles()).toEqual(['Join roles settings changed']);

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

    expect(executor.titles()).toEqual(['Join roles turned on']);
  });

  test('a save that toggled and changed settings logs both', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.config_changed', { ...CONFIG_CHANGED, enabledBefore: false }),
      context(executor),
    );

    expect(executor.titles().sort()).toEqual([
      'Join roles settings changed',
      'Join roles turned on',
    ]);
  });
});

const COMMANDS_CHANGED = {
  auditId: 'audit-2',
  guildId: GUILD,
  actorId: ACTOR,
  source: 'dashboard' as const,
  key: 'ban',
  displayName: 'ban',
  newName: null,
  changed: ['description', 'options'],
  enabledBefore: true,
  enabledAfter: true,
  registration: true,
};

async function logCommandChange(payload: Record<string, unknown>, cfg = config()) {
  const executor = new RecordingExecutor();

  await listener().handler(
    protonEvent('proton.commands_changed', { ...COMMANDS_CHANGED, ...payload }),
    context(executor, cfg),
  );

  return executor;
}

function fieldValues(executor: RecordingExecutor): string[] {
  const fields = (executor.embeds()[0]?.fields ?? []) as Array<{ value: string }>;
  return fields.map((field) => field.value);
}

describe('command changes', () => {
  test('sits beside module settings, in the same category', () => {
    const commands = specByKey('proton.commands_changed');

    expect(commands?.label).toBe('Command settings changed');
    expect(commands?.category).toBe('proton');
    expect(specByKey('proton.config_changed')?.category).toBe('proton');
    expect(SERVERLOG_EVENT_TYPES).toContain('proton.commands_changed');
  });

  test('a settings change names the command, the admin and which settings', async () => {
    const executor = await logCommandChange({});

    expect(executor.titles()).toEqual(['/ban settings changed']);

    const description = String(executor.embeds()[0]?.description);
    expect(description).toContain(`<@${ACTOR}>`);
    expect(description).toContain('dashboard');
    expect(fieldValues(executor)).toEqual(['Description\nOption descriptions']);
    expect(executor.footers()).toEqual(['admin']);
  });

  test('a rename names the command before and after it', async () => {
    const executor = await logCommandChange({ newName: 'punish', changed: ['name'] });

    expect(executor.titles()).toEqual(['/ban settings changed']);
    expect(String(executor.embeds()[0]?.description)).toContain('**Renamed to:** `/punish`');
    expect(fieldValues(executor)).toEqual(['Name']);
  });

  test('a command already renamed still says which of Proton’s commands it is', async () => {
    const executor = await logCommandChange({ displayName: 'punish', changed: ['description'] });

    expect(executor.titles()).toEqual(['/punish settings changed']);
    expect(String(executor.embeds()[0]?.description)).toContain('**Default name:** `/ban`');
  });

  test('renaming back to the default does not repeat the default name', async () => {
    const executor = await logCommandChange({
      displayName: 'punish',
      newName: 'ban',
      changed: ['name'],
    });

    const description = String(executor.embeds()[0]?.description);
    expect(description).toContain('**Renamed to:** `/ban`');
    expect(description).not.toContain('Default name');
  });

  test('description text is never in the embed, only that it changed', async () => {
    const executor = await logCommandChange({
      changed: ['description'],
      description: 'Remove someone for good.',
      optionDescriptions: { reason: 'Why they are going' },
    });

    const embed = JSON.stringify(executor.embeds()[0]);
    expect(embed).not.toContain('Remove someone for good.');
    expect(embed).not.toContain('Why they are going');
    expect(fieldValues(executor)).toEqual(['Description']);
  });

  test('a reply visibility change is named after the dashboard control', async () => {
    const executor = await logCommandChange({ changed: ['privateReply'], registration: false });

    expect(fieldValues(executor)).toEqual(['Respond privately']);
  });

  test('what changed is listed in a fixed order, once each', async () => {
    const executor = await logCommandChange({
      changed: ['privateReply', 'name', 'options', 'name'],
      newName: 'punish',
    });

    expect(fieldValues(executor)).toEqual(['Name\nOption descriptions\nRespond privately']);
  });

  test('switching a command off is titled as the switch, not a settings change', async () => {
    const executor = await logCommandChange({
      changed: ['enabled'],
      enabledAfter: false,
      registration: true,
    });

    expect(executor.titles()).toEqual(['/ban turned off']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Remove);
    expect(executor.embeds()[0]?.fields).toBeUndefined();
  });

  test('switching a command on is titled as the switch', async () => {
    const executor = await logCommandChange({
      changed: ['enabled'],
      enabledBefore: false,
      enabledAfter: true,
    });

    expect(executor.titles()).toEqual(['/ban turned on']);
    expect(executor.embeds()[0]?.color).toBe(ServerLogColors.Add);
  });

  test('a switch saved with other changes is listed among them', async () => {
    const executor = await logCommandChange({
      changed: ['description', 'enabled'],
      enabledAfter: false,
    });

    expect(executor.titles()).toEqual(['/ban settings changed']);
    expect(fieldValues(executor)).toEqual(['Description\nTurned off']);
  });

  test('a context menu is named as it appears in Discord, without a slash', async () => {
    const executor = await logCommandChange({
      key: 'user:Report user',
      displayName: 'Report user',
      changed: ['enabled'],
      enabledAfter: false,
    });

    expect(executor.titles()).toEqual(['“Report user” turned off']);
    expect(String(executor.embeds()[0]?.description)).not.toContain('Default name');
  });

  test('a change that changed nothing posts nothing', async () => {
    const executor = await logCommandChange({ changed: [] });

    expect(executor.requests).toEqual([]);
  });

  test('a malformed payload posts nothing', async () => {
    const executor = await logCommandChange({ guildId: 'not-a-guild' });

    expect(executor.requests).toEqual([]);
  });

  test('a module actor is named without pretending to be a user', async () => {
    const executor = await logCommandChange({ actorId: 'proton:commands', source: 'system' });

    const description = String(executor.embeds()[0]?.description);
    expect(description).toContain('`commands`');
    expect(description).not.toContain('<@proton:');
  });

  test('a redelivered change posts under the same key', async () => {
    const executor = new RecordingExecutor();
    const event = protonEvent('proton.commands_changed', COMMANDS_CHANGED);

    await listener().handler(event, context(executor));
    await listener().handler(event, context(executor));

    const keys = executor.requests.map((request) => request.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  test('its own switch silences it without silencing module settings', async () => {
    const cfg = config({ events: { 'proton.commands_changed': { enabled: false } } });

    expect((await logCommandChange({}, cfg)).requests).toEqual([]);

    const executor = new RecordingExecutor();
    await listener().handler(
      protonEvent('proton.config_changed', CONFIG_CHANGED),
      context(executor, cfg),
    );
    expect(executor.titles()).toEqual(['Join roles settings changed']);
  });
});

describe('actions Proton took', () => {
  const ROLE_ADDED = {
    caseId: 'case-1',
    guildId: GUILD,
    moduleId: 'joinroles',
    kind: 'add_role' as const,
    actorId: ACTOR,
    targetId: '100000000000000007',
    reason: 'joined the server',
    dryRun: false,
    expiresAt: null,
  };

  test('an action is logged with its case id and reason', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(protonEvent('proton.action_executed', ROLE_ADDED), context(executor));

    expect(executor.titles()).toEqual(['Proton added a role']);

    const description = String(executor.embeds()[0]?.description);
    expect(description).toContain('case-1');
    expect(description).toContain('joined the server');
  });

  test('a module actor is named without pretending to be a user', async () => {
    const executor = new RecordingExecutor();

    await listener().handler(
      protonEvent('proton.action_executed', { ...ROLE_ADDED, actorId: 'proton:joinroles' }),
      context(executor),
    );

    expect(String(executor.embeds()[0]?.description)).toContain('joinroles');
    expect(String(executor.embeds()[0]?.description)).not.toContain('<@proton:');
  });

  test('a moderation action is not rendered as a Proton action', () => {
    const rendered = renderActionExecuted({
      guildId: GUILD,
      entity: { ...ROLE_ADDED, kind: 'ban' },
      audit: null,
      executor: null,
      occurredAt: 1_700_000_000_000,
      emojis: EMOJIS,
    });

    expect(rendered).toBeNull();
  });

  test('the log says honestly what it covers', () => {
    expect(specByKey('proton.action_executed')?.label).toBe('Proton took an action');
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

    expect(executor.titles()).toEqual(['Anti-Nuke triggered']);
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

  test('a trip is titled after the module that tripped, Honeypot included', async () => {
    const executor = new RecordingExecutor();

    for (const moduleId of ['antiraid', 'honeypot'] as const) {
      await listener().handler(
        {
          ...protonEvent('proton.security_tripped', {
            guildId: GUILD,
            moduleId,
            trigger: 'join',
            actorId: null,
            summary: 'a burst of joins',
          }),
          id: `proton.security_tripped:${moduleId}`,
        },
        context(executor),
      );
    }

    expect(executor.titles()).toEqual(['Anti-Raid triggered', 'Honeypot triggered']);
  });
});

describe('Proton’s own audit entries are not logged twice', () => {
  test('a ban Proton performed is not logged from its audit entry', async () => {
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

describe('the Proton category can be disabled', () => {
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

  test('command changes follow the same category switch', async () => {
    const executor = await logCommandChange(
      {},
      config({ categories: { ...serverlogDefaultConfig.categories, proton: false } }),
    );

    expect(executor.requests).toEqual([]);
  });
});
