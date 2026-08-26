import { describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { phishingConfigSchema, phishingDefaultConfig } from '../src/config.ts';
import { createPhishingModule, phishingModule } from '../src/index.ts';
import { BLOCKLIST_QUEUE, BLOCKLIST_REFRESH_JOB_ID } from '../src/refresh.ts';
import { BOT, MemoryBlocklistStore } from './harness.ts';

const ALL_INTENTS =
  GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;

function registry(): ModuleRegistry {
  const built = new ModuleRegistry();
  built.register(phishingModule as ModuleManifest);
  return built;
}

describe('phishing manifest', () => {
  test('registers — its config schema is one the dashboard can render', () => {
    expect(() => registry()).not.toThrow();
  });

  test('every dashboard section names a real config key', () => {
    const keys = new Set(Object.keys(phishingConfigSchema.shape));
    for (const section of phishingModule.dashboard?.sections ?? []) {
      for (const field of section.fields) expect(keys.has(field)).toBe(true);
    }
  });

  test('the default config satisfies its own schema', () => {
    expect(phishingConfigSchema.safeParse(phishingDefaultConfig).success).toBe(true);
  });

  test('declares the message events it scans', () => {
    expect(phishingModule.listeners?.[0]?.types).toEqual(['message.created', 'message.updated']);
  });

  test('declares the recurring blocklist refresh, in UTC', () => {
    const job = phishingModule.jobs?.[0];
    expect(job?.id).toBe(BLOCKLIST_REFRESH_JOB_ID);
    expect(job?.timezone).toBeUndefined();
  });

  test('its queue name has no colon — BullMQ builds its own keys with one', () => {
    expect(BLOCKLIST_QUEUE).not.toContain(':');
  });

  test('binding deps does not change the manifest the dashboard sees', () => {
    const bound = createPhishingModule({ blocklist: new MemoryBlocklistStore(), botUserId: BOT });

    expect(bound.id).toBe(phishingModule.id);
    expect(bound.requiredIntents).toEqual(phishingModule.requiredIntents);
    expect(bound.requiredPermissions).toEqual(phishingModule.requiredPermissions);
    expect(bound.schemaVersion).toBe(phishingModule.schemaVersion);
  });

  test('runs when the intents and permission are granted', () => {
    const status = registry().evaluate('phishing', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(true);
  });

  test('stays enabled without ModerateMembers, BanMembers or KickMembers', () => {
    const status = registry().evaluate('phishing', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(true);
    expect(phishingModule.requiredPermissions).toEqual([Permissions.ViewChannel]);
  });
});

describe('phishing failure paths', () => {
  test('disables itself and names MESSAGE_CONTENT when the intent is missing', () => {
    const status = registry().evaluate('phishing', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');

    expect(status.disabledReason?.humanReason).toContain('Message Content Intent');
    expect(status.disabledReason?.humanReason).toContain('developer portal');
  });

  test('disables itself and names VIEW_CHANNEL when the permission is missing', () => {
    const status = registry().evaluate('phishing', {
      grantedIntents: ALL_INTENTS,
      botPermissions: Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('View Channel');
  });
});
