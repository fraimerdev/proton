import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { honeypotConfigSchema, honeypotDefaultConfig, honeypotFormSchema } from '../src/config.ts';
import { honeypotModule } from '../src/index.ts';

const GRANTED_INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages;

function registry(): ModuleRegistry {
  const registered = new ModuleRegistry();
  registered.register(honeypotModule);
  return registered;
}

describe('the manifest', () => {
  test('registers, which means its settings render as a form (§9)', () => {
    const paths = registry()
      .descriptors('honeypot')
      .map((descriptor) => descriptor.path);

    expect(paths).toEqual(['enabled', 'logChannelId', 'includeThreads']);
    expect(paths).toHaveLength(Object.keys(honeypotFormSchema.shape).length);
  });

  test('keeps the channel list out of the generated form, which cannot render it', () => {
    const paths = registry()
      .descriptors('honeypot')
      .map((descriptor) => descriptor.path);

    expect(paths).not.toContain('channels');
    expect(Object.keys(honeypotConfigSchema.shape)).toContain('channels');
  });

  test('offers the incident log as a channel picker', () => {
    const descriptor = registry()
      .descriptors('honeypot')
      .find((candidate) => candidate.path === 'logChannelId');

    expect(descriptor?.kind).toBe('channel-id');
  });

  test('ships defaults its own schema accepts, and that trap nobody', () => {
    expect(honeypotConfigSchema.safeParse(honeypotDefaultConfig).success).toBe(true);
    expect(honeypotDefaultConfig.enabled).toBe(false);
    expect(honeypotDefaultConfig.channels).toEqual([]);
  });

  test('asks for Ban Members and nothing else', () => {
    expect(honeypotModule.requiredPermissions).toEqual([Permissions.BanMembers]);
  });

  test('never asks for Message Content — it reads that a message exists, not what it says', () => {
    expect(honeypotModule.requiredIntents).not.toContain(GatewayIntentBits.MessageContent);
    expect(honeypotModule.requiredIntents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ]);
  });

  test('runs on the unprivileged pair alone', () => {
    const status = registry().evaluate('honeypot', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.BanMembers,
    });

    expect(status).toEqual({ id: 'honeypot', enabled: true });
  });

  test('is disabled with the permission named when it cannot ban', () => {
    const status = registry().evaluate('honeypot', {
      grantedIntents: GRANTED_INTENTS,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_permission');
    expect(status.disabledReason?.humanReason).toContain('BanMembers');
  });

  test('is disabled with the intent named when it cannot see messages', () => {
    const status = registry().evaluate('honeypot', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.BanMembers,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.code).toBe('missing_intent');
    expect(status.disabledReason?.humanReason).toContain('GuildMessages');
  });

  test('declares every kind a trap and its notice can execute', () => {
    expect(new Set(honeypotModule.actionKinds)).toEqual(
      new Set(['ban', 'unban', 'kick', 'timeout', 'warn', 'delete_message', 'send']),
    );
  });

  test('listens for messages and for its own notice request, and nothing else', () => {
    expect(honeypotModule.listeners?.map((listener) => listener.types)).toEqual([
      ['message.created'],
      ['honeypot.notice_requested'],
    ]);
  });

  test('is configured from the dashboard alone — no slash commands', () => {
    expect(honeypotModule.commands ?? []).toEqual([]);
  });

  test('caps the channel list at the tier limit, which only a save can enforce', () => {
    expect(honeypotModule.configLimits).toEqual([{ key: 'honeypotChannels', path: 'channels' }]);
  });

  test('every dashboard section names a real config key, and only the list is left out', () => {
    const keys = new Set(Object.keys(honeypotConfigSchema.shape));
    const claimed = honeypotModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(claimed.length).toBeGreaterThan(0);
    for (const field of claimed) expect(keys.has(field)).toBe(true);
    expect(new Set(claimed).size).toBe(keys.size - 1);
  });
});
