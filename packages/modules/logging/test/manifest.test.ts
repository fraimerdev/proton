import { describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { loggingModule } from '../src/index.ts';
import { PARTITION_MAINTENANCE_JOB_ID } from '../src/maintenance.ts';

const ALL_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(loggingModule as ModuleManifest);
  return built;
}

describe('logging manifest', () => {
  test('registers — its config schema is one the dashboard can render', () => {
    expect(() => registry()).not.toThrow();
  });

  test('declares the three message events it exists for', () => {
    expect(loggingModule.listeners?.[0]?.types).toEqual([
      'message.updated',
      'message.deleted',
      'message.bulk_deleted',
    ]);
  });

  test('declares the daily partition maintenance job in UTC', () => {
    const job = loggingModule.jobs?.[0];
    expect(job?.id).toBe(PARTITION_MAINTENANCE_JOB_ID);

    expect(job?.timezone).toBeUndefined();
    expect(job?.payload).toEqual({ retentionDays: 30, lookaheadDays: 1 });
  });

  test('runs when the intents and permission are granted', () => {
    const status = registry().evaluate('logging', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(true);
  });
});

describe('logging failure paths', () => {
  test('disables itself and names MESSAGE_CONTENT when the intent is missing', () => {
    const status = registry().evaluate('logging', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');

    expect(status.disabledReason?.humanReason).toContain('Message Content Intent');
    expect(status.disabledReason?.humanReason).toContain('developer portal');
  });

  test('disables itself and names VIEW_CHANNEL when the permission is missing', () => {
    const status = registry().evaluate('logging', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('View Channel');
  });
});
