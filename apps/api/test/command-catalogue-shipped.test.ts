import { describe, expect, test } from 'bun:test';
import { commandCatalogue, commandCatalogueViewSchema } from '@proton/core';
import { createModuleRegistry } from '@proton/modules';
import { CommandSettingsService } from '../src/commands/service.ts';
import type { ModuleState } from '../src/modules/service.ts';
import { GUILD, MemoryCommandSettingsStore, MemoryRegistrationStore } from './command-fixtures.ts';

const registry = createModuleRegistry();

function serviceOver(states: Record<string, ModuleState>, errors: string[]) {
  return new CommandSettingsService({
    registry,
    settings: new MemoryCommandSettingsStore(),
    registrations: new MemoryRegistrationStore(),
    modules: { moduleStates: async () => states },
    scope: { scope: 'every-guild', testGuildId: null },
    logger: { error: (message: string) => errors.push(message) },
  });
}

describe('the catalogue of the commands Proton ships', () => {
  test('reads every shipped command on module defaults without a reply default throwing', async () => {
    const errors: string[] = [];
    const states = Object.fromEntries(
      registry.all().map((manifest) => [manifest.id, { on: true, config: manifest.defaultConfig }]),
    );

    const view = commandCatalogueViewSchema.parse(
      await serviceOver(states, errors).catalogue(GUILD),
    );

    expect(errors).toEqual([]);
    expect(view.commands.map((command) => command.key)).toEqual(
      commandCatalogue(registry).map((entry) => entry.key),
    );
    expect(view.commands.every((command) => command.effectiveName === command.name)).toBe(true);
    expect(view.commands.every((command) => command.ignored === null)).toBe(true);
  });
});
