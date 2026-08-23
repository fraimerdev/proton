import { describe, expect, test } from 'bun:test';
import { CORE_PROVIDER_IDS, ProviderRegistry } from '@proton/core';
import { createModuleRegistry } from '@proton/modules';

const GUILD = '100000000000000000';

function availability(enabled: Record<string, boolean>) {
  return {
    async isEnabled(_guildId: string, moduleId: string) {
      return enabled[moduleId] === true;
    },
  };
}

describe('the provider picker the builder and the dashboard read', () => {
  test('an unbound deployment still offers the core conditions', async () => {
    const registry = createModuleRegistry();
    const listed = await registry.availableProviders(GUILD, availability({}));

    expect(listed.map((provider) => provider.id)).toEqual([...CORE_PROVIDER_IDS].sort());
  });

  test('every registered module can be registered together without an id clash', () => {
    expect(() => createModuleRegistry()).not.toThrow();
  });

  test('a bound deployment offers the modules that own providers, and only when enabled', async () => {
    const providers = new ProviderRegistry();

    const registry = createModuleRegistry(
      {
        giveaways: {
          store: {
            async recentWinCounts() {
              return new Map();
            },
            async priorEntryCounts() {
              return new Map();
            },
          } as never,
        },
      },
      { providers },
    );

    const off = await registry.availableProviders(GUILD, availability({}));
    const on = await registry.availableProviders(GUILD, availability({ giveaways: true }));

    expect(off.some((provider) => provider.moduleId === 'giveaways')).toBe(false);
    expect(on.some((provider) => provider.id === 'giveaways.no_recent_wins')).toBe(true);
  });

  test('what it returns is renderable — every provider carries a builder inside the modal limit', async () => {
    const registry = createModuleRegistry();
    const listed = await registry.availableProviders(GUILD, availability({}));

    for (const provider of listed) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.description.length).toBeGreaterThan(0);
      expect(provider.builder.length).toBeLessThanOrEqual(5);
    }
  });

  test('providers are namespaced to the module that owns them', async () => {
    const registry = createModuleRegistry();

    for (const provider of await registry.availableProviders(GUILD, availability({}))) {
      expect(provider.id.startsWith(`${provider.moduleId}.`)).toBe(true);
    }
  });
});
