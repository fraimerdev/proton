import { describe, expect, test } from 'bun:test';
import { ApplicationCommandType, GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import type {
  ContextMenuDefinition,
  ContextMenuType,
  ModuleManifest,
} from '../../src/modules/manifest.ts';
import {
  MAX_CONTEXT_MENUS_PER_TYPE,
  ModuleRegistrationError,
  ModuleRegistry,
} from '../../src/modules/registry.ts';

function menu(name: string, type: ContextMenuType): ContextMenuDefinition {
  return {
    name,
    type,
    description: `${name}, from the Apps menu.`,
    data: {
      name,
      type: type === 'user' ? ApplicationCommandType.User : ApplicationCommandType.Message,
    },
    handler: async () => undefined,
  };
}

function manifest(id: string, contextMenus: ContextMenuDefinition[]): ModuleManifest {
  return {
    id,
    name: id,
    category: 'moderation',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [],
    contextMenus,
  } as unknown as ModuleManifest;
}

describe('context menus at registration', () => {
  test('a module may declare user and message menus', () => {
    const registry = new ModuleRegistry();

    registry.register(
      manifest('moderation', [menu('Report user', 'user'), menu('Report message', 'message')]),
    );

    expect(registry.get('moderation')?.contextMenus).toHaveLength(2);
  });

  test('a user and a message menu may share a name, as Discord allows', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(
        manifest('moderation', [menu('Report', 'user'), menu('Report', 'message')]),
      ),
    ).not.toThrow();
  });

  test('refuses a name another module already uses for the same type, and names it', () => {
    const registry = new ModuleRegistry();
    registry.register(manifest('moderation', [menu('Report user', 'user')]));

    expect(() => registry.register(manifest('tickets', [menu('report user', 'user')]))).toThrow(
      /user context menu 'report user' is already declared by 'moderation'/,
    );
    expect(registry.get('tickets')).toBeUndefined();
  });

  test('refuses the same menu declared twice in one module', () => {
    const registry = new ModuleRegistry();

    expect(() =>
      registry.register(
        manifest('moderation', [
          menu('Report message', 'message'),
          menu('Report message', 'message'),
        ]),
      ),
    ).toThrow(/declared twice/);
  });

  test(`refuses a sixteenth menu of one type across every module`, () => {
    const registry = new ModuleRegistry();
    const names = Array.from({ length: MAX_CONTEXT_MENUS_PER_TYPE }, (_, i) => `Menu ${i}`);
    registry.register(
      manifest(
        'first',
        names.map((name) => menu(name, 'user')),
      ),
    );

    expect(() => registry.register(manifest('second', [menu('One too many', 'user')]))).toThrow(
      ModuleRegistrationError,
    );
    expect(() => registry.register(manifest('second', [menu('One too many', 'user')]))).toThrow(
      /16 user context menus, and Discord allows 15/,
    );
  });

  test('the fifteen-menu cap counts each type on its own', () => {
    const registry = new ModuleRegistry();
    const names = Array.from({ length: MAX_CONTEXT_MENUS_PER_TYPE }, (_, i) => `Menu ${i}`);
    registry.register(
      manifest(
        'first',
        names.map((name) => menu(name, 'user')),
      ),
    );

    expect(() => registry.register(manifest('second', [menu('Menu 0', 'message')]))).not.toThrow();
  });

  test('refuses data whose name or type disagrees with the definition the runtime routes on', () => {
    const renamed = { ...menu('Report user', 'user'), data: menu('Report', 'user').data };
    const retyped = { ...menu('Report user', 'user'), data: menu('Report user', 'message').data };

    expect(() => new ModuleRegistry().register(manifest('a', [renamed]))).toThrow(
      /different name or type/,
    );
    expect(() => new ModuleRegistry().register(manifest('a', [retyped]))).toThrow(
      /different name or type/,
    );
  });

  test('a module with no context menus is untouched by the check', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(manifest('ping', []))).not.toThrow();
  });
});
