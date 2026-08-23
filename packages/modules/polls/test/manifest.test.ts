import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { ANNOUNCE_JOB } from '../src/announce.ts';
import { createPollsModule } from '../src/index.ts';

const DEFAULT_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildModeration |
  GatewayIntentBits.MessageContent |
  GatewayIntentBits.GuildMessageReactions |
  GatewayIntentBits.GuildMessagePolls |
  GatewayIntentBits.GuildVoiceStates |
  GatewayIntentBits.AutoModerationConfiguration |
  GatewayIntentBits.AutoModerationExecution;

function registered(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(createPollsModule());
  return registry;
}

describe('the polls manifest', () => {
  test('registers, so every rule the registry enforces holds', () => {
    expect(() => registered()).not.toThrow();
  });

  test('declares every action kind its code paths execute', () => {
    const registry = registered();

    for (const kind of ['interaction_reply', 'interaction_followup', 'send', 'end_poll'] as const) {
      expect(registry.mayExecute('polls', kind)).toBe(true);
    }
  });

  test('declares the durable schedule its commands book', () => {
    expect(registered().maySchedule('polls', ANNOUNCE_JOB)).toBe(true);
  });

  test('asks the invite for the permission a poll payload needs', () => {
    expect(registered().invitePermissions() & Permissions.SendPolls).toBe(Permissions.SendPolls);
  });

  test('needs no intent the gateway does not already ask Discord for', () => {
    expect(registered().requiredIntents() & ~DEFAULT_INTENTS).toBe(0);
  });

  test('every dashboard field is a real config key', () => {
    const manifest = createPollsModule();
    const keys = new Set(Object.keys(manifest.configSchema.shape));

    for (const section of manifest.dashboard?.sections ?? []) {
      for (const field of section.fields) expect(keys.has(field)).toBe(true);
    }
  });
});
