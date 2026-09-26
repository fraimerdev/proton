import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  CommandContext,
  ContextMenuContext,
  EventBus,
  Logger,
  ModuleManifest,
  ProtonEvent,
  Subscription,
} from '@proton/core';
import { ModuleRegistry } from '@proton/core';
import { type DispatchName, dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { permissionsModule } from '@proton/module-permissions';
import { ApplicationCommandType, GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { ModuleRuntime } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const INVOKER = '100000000000000001';
const TARGET_USER = '100000000000000003';
const TARGET_MESSAGE = '1400000000000000010';
const APPLICATION = '800000000000000001';

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return { status: 'executed' };
  }
}

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: (): Subscription => {
    throw new Error('not used');
  },
};

const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Seen {
  menus: ContextMenuContext[];
  commands: CommandContext[];
}

function reportsModule(seen: Seen, options: { throws?: boolean } = {}): ModuleManifest {
  const onMenu = async (ctx: ContextMenuContext) => {
    seen.menus.push(ctx);
    if (options.throws) throw new Error('the store was unreachable');
  };

  return {
    id: 'reports',
    name: 'Reports',
    category: 'moderation',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [],
    actionKinds: ['interaction_reply'],
    dashboard: { icon: 'flag', sections: [] },
    commands: [
      {
        name: 'report',
        description: 'Report a member.',
        data: { name: 'report', description: 'Report a member.' },
        handler: async (ctx: CommandContext) => {
          seen.commands.push(ctx);
        },
      },
    ],
    contextMenus: [
      {
        name: 'Report user',
        type: 'user',
        description: 'Report a member from their profile.',
        data: { name: 'Report user', type: ApplicationCommandType.User },
        handler: onMenu,
      },
      {
        name: 'Report message',
        type: 'message',
        description: 'Report a message.',
        data: { name: 'Report message', type: ApplicationCommandType.Message },
        handler: onMenu,
      },
      {
        name: 'report',
        type: 'user',
        description: 'Shares its name with the slash command.',
        data: { name: 'report', type: ApplicationCommandType.User },
        handler: onMenu,
      },
    ],
  } as unknown as ModuleManifest;
}

function build(
  options: {
    enabled?: boolean;
    overrides?: Record<string, string[]>;
    throws?: boolean;
    withPermissions?: boolean;
  } = {},
) {
  const seen: Seen = { menus: [], commands: [] };
  const executor = new RecordingExecutor();
  const registry = new ModuleRegistry();
  registry.register(reportsModule(seen, { throws: options.throws ?? false }));
  if (options.withPermissions) registry.register(permissionsModule as unknown as ModuleManifest);

  const runtime = new ModuleRuntime({
    bus,
    registry,
    executor,
    logger,
    dashboardUrl: 'https://proton.example',
    config: {
      get: async (_guildId, moduleId) =>
        moduleId === 'permissions'
          ? { enabled: true, config: { enabled: true, overrides: options.overrides ?? {} } }
          : { enabled: options.enabled ?? true, config: { enabled: true } },
    },
  });

  return { runtime, executor, seen };
}

function recorded(name: DispatchName, edit?: (d: Record<string, unknown>) => void): ProtonEvent {
  const raw = dispatch(name);
  edit?.(raw.d);
  const event = normalise(raw)[0];
  if (!event) throw new Error(`${name} did not normalise`);
  return event;
}

function data(d: Record<string, unknown>): Record<string, unknown> {
  return d.data as Record<string, unknown>;
}

function replied(executor: RecordingExecutor): string {
  const payload = executor.requests[0]?.payload as
    | { embeds?: Array<{ description?: string }> }
    | undefined;
  return payload?.embeds?.[0]?.description ?? '';
}

describe('a USER context menu', () => {
  test('reaches the menu with the target and the resolved user and member', async () => {
    const { runtime, seen } = build();

    await runtime.handle(recorded('interactionCreateUserCommand'));

    const ctx = seen.menus[0];
    expect(seen.menus).toHaveLength(1);
    expect(seen.commands).toHaveLength(0);
    expect(ctx?.commandType).toBe('user');
    expect(ctx?.targetId).toBe(TARGET_USER);
    expect(ctx?.resolved.users.get(TARGET_USER)?.username).toBe('rulebreaker');
    expect(ctx?.resolved.members.get(TARGET_USER)?.roleIds).toEqual([
      '700000000000000001',
      '700000000000000002',
    ]);
  });

  test('carries who invoked it, where, and the ids a follow-up needs', async () => {
    const { runtime, seen } = build();

    await runtime.handle(recorded('interactionCreateUserCommand'));

    const ctx = seen.menus[0];
    expect(ctx?.guildId).toBe(GUILD);
    expect(ctx?.channelId).toBe(CHANNEL);
    expect(ctx?.userId).toBe(INVOKER);
    expect(ctx?.actorRoleIds).toEqual(['400000000000000001']);
    expect(ctx?.actorPermissions).toBe(1071698660929n);
    expect(ctx?.applicationId).toBe(APPLICATION);
    expect(ctx?.interaction).toEqual({
      id: '1500000000000000005',
      token: 'user-command-interaction-token',
    });
    expect(ctx?.idempotencyKey).toBe('interaction.command:1500000000000000005');
    expect(ctx && 'options' in ctx).toBe(false);
  });
});

describe('a MESSAGE context menu', () => {
  test('reaches the menu with the target message resolved for a snapshot', async () => {
    const { runtime, seen } = build();

    await runtime.handle(recorded('interactionCreateMessageCommand'));

    const ctx = seen.menus[0];
    const message = ctx?.resolved.messages.get(TARGET_MESSAGE);
    expect(ctx?.commandType).toBe('message');
    expect(ctx?.targetId).toBe(TARGET_MESSAGE);
    expect(message?.author?.id).toBe(TARGET_USER);
    expect(message?.content).toBe('Free nitro for everyone who clicks the link in my bio');
    expect(message?.attachments[0]?.filename).toBe('proof.png');
    expect(message?.attachments[0]?.expiresAt).toBe(Date.parse('2026-10-02T12:00:00Z'));
  });
});

describe('dispatch is by name and type', () => {
  test('a user menu and a slash command sharing a name each reach their own handler', async () => {
    const { runtime, seen } = build();

    await runtime.handle(
      recorded('interactionCreateUserCommand', (d) => {
        data(d).name = 'report';
      }),
    );
    await runtime.handle(
      recorded('interactionCreatePing', (d) => {
        data(d).name = 'report';
      }),
    );

    expect(seen.menus).toHaveLength(1);
    expect(seen.menus[0]?.commandType).toBe('user');
    expect(seen.commands).toHaveLength(1);
  });

  test('a message menu with a user menu’s name is not the user menu', async () => {
    const { runtime, executor, seen } = build();

    await runtime.handle(
      recorded('interactionCreateMessageCommand', (d) => {
        data(d).name = 'Report user';
      }),
    );

    expect(seen.menus).toHaveLength(0);
    expect(replied(executor)).toContain("`Apps → Report user` isn't working");
  });

  test('a menu with no target is dropped rather than handled blind', async () => {
    const { runtime, executor, seen } = build();

    await runtime.handle(
      recorded('interactionCreateUserCommand', (d) => {
        delete data(d).target_id;
      }),
    );

    expect(seen.menus).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
  });
});

describe('slash commands see resolved data too', () => {
  test('the slash handler gets the resolved block, the application id and its options', async () => {
    const { runtime, seen } = build();

    await runtime.handle(
      recorded('interactionCreatePing', (d) => {
        d.application_id = APPLICATION;
        data(d).name = 'report';
        data(d).options = [{ name: 'evidence', type: 11, value: '1430000000000000001' }];
        data(d).resolved = {
          attachments: {
            '1430000000000000001': {
              id: '1430000000000000001',
              filename: 'proof.png',
              size: 10,
              url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/proof.png?ex=6aae7940',
              ephemeral: true,
            },
          },
        };
      }),
    );

    const ctx = seen.commands[0];
    expect(ctx?.applicationId).toBe(APPLICATION);
    expect(ctx?.resolved?.attachments.size).toBe(1);
    expect(ctx?.options.getAttachment('evidence')?.filename).toBe('proof.png');
  });
});

describe('context menus and the permissions module', () => {
  test('an override on a slash name refuses the slash command but not a menu of that name', async () => {
    const { runtime, executor, seen } = build({
      withPermissions: true,
      overrides: { report: ['400000000000000999'] },
    });

    await runtime.handle(
      recorded('interactionCreatePing', (d) => {
        data(d).name = 'report';
      }),
    );
    await runtime.handle(
      recorded('interactionCreateUserCommand', (d) => {
        data(d).name = 'report';
      }),
    );

    expect(seen.commands).toHaveLength(0);
    expect(executor.requests[0]?.moduleId).toBe('permissions');
    expect(seen.menus).toHaveLength(1);
  });
});

describe('refusals name a menu the way Discord shows it', () => {
  test('a disabled module says Apps → name, not /name', async () => {
    const { runtime, executor, seen } = build({ enabled: false });

    await runtime.handle(recorded('interactionCreateMessageCommand'));

    const text = replied(executor);
    expect(seen.menus).toHaveLength(0);
    expect(text).toContain("`Apps → Report message` can't run");
    expect(text).not.toContain('/Report message');
  });

  test('a menu nobody owns is answered under the same name', async () => {
    const { runtime, executor } = build();

    await runtime.handle(
      recorded('interactionCreateUserCommand', (d) => {
        data(d).name = 'Ghost';
      }),
    );

    expect(replied(executor)).toContain('`Apps → Ghost`');
  });

  test('a menu that throws still tells the invoker, and still propagates', async () => {
    const { runtime, executor } = build({ throws: true });

    await expect(runtime.handle(recorded('interactionCreateUserCommand'))).rejects.toThrow(
      'the store was unreachable',
    );
    expect(replied(executor)).toContain('Something went wrong with `Apps → Report user`');
  });
});
