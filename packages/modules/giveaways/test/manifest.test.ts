import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions, ProviderRegistry } from '@proton/core';
import { MODULE_ID } from '../src/config.ts';
import { createGiveawaysModule } from '../src/index.ts';
import { MemoryGiveawayStore } from './memory-store.ts';

function registered(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(
    createGiveawaysModule({ store: new MemoryGiveawayStore(), providers: new ProviderRegistry() }),
  );
  return registry;
}

describe('the giveaways manifest', () => {
  test('registers, so every rule the registry enforces holds', () => {
    expect(() => registered()).not.toThrow();
  });

  test('declares every action kind its code paths execute', () => {
    const registry = registered();

    for (const kind of [
      'interaction_reply',
      'interaction_followup',
      'send',
      'edit_message',
      'giveaway_draw',
      'create_dm',
      'add_role',
    ] as const) {
      expect(registry.mayExecute(MODULE_ID, kind)).toBe(true);
    }
  });

  test('asks the invite for the permission a reward role needs', () => {
    expect(registered().invitePermissions() & Permissions.ManageRoles).toBe(
      Permissions.ManageRoles,
    );
  });
});
