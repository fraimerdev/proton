import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  CommandContext,
  EventBus,
  Logger,
  ModuleManifest,
  ProtonEvent,
  Subscription,
} from '@proton/core';
import { ModuleRegistry } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { ConfigUnavailableError } from '../src/config-provider.ts';
import { disabledReason, ModuleRuntime } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const DASHBOARD = 'https://proton.example';

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  result: ActionResult = { status: 'executed', caseId: 'case-1' };

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.result;
  }
}

const bus: EventBus = {
  publish: async () => undefined,
  subscribe: (): Subscription => {
    throw new Error('not used');
  },
};

function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
}

const configSchema = z.object({
  enabled: z.boolean().default(true),
  response: z.string().default('Pong!'),
});

function manifest(): ModuleManifest {
  return {
    id: 'ping',
    name: 'Ping',
    category: 'utility',
    configSchema,
    defaultConfig: { enabled: true, response: 'Pong!' },
    schemaVersion: 1,
    requiredIntents: [GatewayIntentBits.Guilds],
    requiredPermissions: [],
    actionKinds: ['interaction_reply'],
    commands: [
      {
        name: 'ping',
        description: 'ping',
        data: { name: 'ping', description: 'ping' },
        handler: async (ctx: CommandContext) => {
          await ctx.executor.execute({
            guildId: ctx.guildId,
            moduleId: 'ping',
            kind: 'interaction_reply',
            actorId: ctx.userId,
            idempotencyKey: `${ctx.idempotencyKey}:handled`,
            dryRun: false,
            payload: {
              interactionId: ctx.interaction.id,
              interactionToken: ctx.interaction.token,
              content: 'handled',
            },
          });
        },
      },
    ],
  } as unknown as ModuleManifest;
}

function commandEvent(): ProtonEvent {
  const event = normalise(dispatch('interactionCreatePing'))[0];
  if (!event) throw new Error('interactionCreatePing did not normalise');
  return event;
}

function runtimeWith(snapshot: { enabled: boolean; config: unknown } | Error) {
  const executor = new RecordingExecutor();
  const { logger, lines } = collectingLogger();
  const registry = new ModuleRegistry();
  registry.register(manifest());

  const runtime = new ModuleRuntime({
    bus,
    registry,
    executor,
    logger,
    dashboardUrl: DASHBOARD,
    config: {
      get: async () => {
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    },
  });

  return { runtime, executor, lines };
}

function payloadOf(executor: RecordingExecutor): Record<string, unknown> {
  const request = executor.requests[0];
  if (!request) throw new Error('nothing was replied');
  return (request.payload ?? {}) as Record<string, unknown>;
}

function replyContent(executor: RecordingExecutor): string {
  const request = executor.requests[0];
  if (!request) throw new Error('nothing was replied');
  return String((request.payload as { content?: unknown }).content ?? '');
}

describe('a command that cannot run still answers', () => {
  test('the happy path still dispatches to the module', async () => {
    const { runtime, executor } = runtimeWith({ enabled: true, config: { enabled: true } });

    await runtime.handle(commandEvent());

    expect(replyContent(executor)).toBe('handled');
  });

  test('a module switched off at the row level names the module and links the settings', async () => {
    const { runtime, executor } = runtimeWith({ enabled: false, config: { enabled: true } });

    await runtime.handle(commandEvent());

    const content = replyContent(executor);
    expect(content).toContain('Ping');
    expect(content).toContain('switched off');
    expect(content).toContain(`${DASHBOARD}/dashboard/${GUILD}/ping`);

    // One switch, so the refusal names one place. It used to distinguish "Module enabled" from the
    // config field's "Enabled", which the dashboard no longer renders.
    expect(content).toContain('sidebar');
    expect(content).not.toContain('Module enabled');
  });

  test('a module switched off in its own config is refused the same way', async () => {
    const { runtime, executor } = runtimeWith({ enabled: true, config: { enabled: false } });

    await runtime.handle(commandEvent());

    const content = replyContent(executor);
    expect(content).toContain('switched off');
    expect(content).toContain(`${DASHBOARD}/dashboard/${GUILD}/ping`);
  });

  test('a disabled module never reaches its handler', async () => {
    const { runtime, executor } = runtimeWith({ enabled: false, config: { enabled: true } });

    await runtime.handle(commandEvent());

    expect(executor.requests).toHaveLength(1);
    expect(replyContent(executor)).not.toBe('handled');
  });

  test('the refusal is ephemeral — only the invoker needs it', async () => {
    const { runtime, executor } = runtimeWith({ enabled: false, config: {} });

    await runtime.handle(commandEvent());

    expect((payloadOf(executor) as { ephemeral?: boolean }).ephemeral).toBe(true);
  });

  test('unreadable settings say how to repair them', async () => {
    const { runtime, executor } = runtimeWith(
      new ConfigUnavailableError({
        message: 'the module is unknown',
        permanent: true,
        guildId: GUILD,
        moduleId: 'ping',
        status: 404,
      }),
    );

    await runtime.handle(commandEvent());

    const content = replyContent(executor);
    expect(content).toContain('Ping');
    expect(content).toContain('Save');
    expect(content).toContain(`${DASHBOARD}/dashboard/${GUILD}/ping`);
  });

  test('invalid stored settings name the field that is wrong', async () => {
    const { runtime, executor } = runtimeWith({ enabled: true, config: { response: 42 } });

    await runtime.handle(commandEvent());

    expect(replyContent(executor)).toContain('response');
  });

  test('a command no module owns is answered rather than left hanging', async () => {
    const { runtime, executor } = runtimeWith({ enabled: true, config: { enabled: true } });
    const event = commandEvent();
    (event.payload as { data: { name: string } }).data.name = 'ghost';

    await runtime.handle(event);

    expect(replyContent(executor)).toContain('/ghost');
  });

  test('a transient config failure propagates instead of being answered', async () => {
    const { runtime } = runtimeWith(
      new ConfigUnavailableError({
        message: 'api restarting',
        permanent: false,
        guildId: GUILD,
        moduleId: 'ping',
        status: 503,
      }),
    );

    expect(runtime.handle(commandEvent())).rejects.toThrow();
  });

  test('a redelivered interaction refuses under the same idempotency key', async () => {
    const { runtime, executor } = runtimeWith({ enabled: false, config: {} });

    await runtime.handle(commandEvent());
    await runtime.handle(commandEvent());

    expect(executor.requests[0]?.idempotencyKey).toBe(executor.requests[1]?.idempotencyKey ?? '');
  });
});

describe('disabledReason', () => {
  test('the row-level switch wins, because it is the one the dashboard shows first', () => {
    expect(disabledReason({ enabled: false, config: { enabled: false } }, configSchema)).toBe(
      'module',
    );
  });

  test('the config switch is reported separately, so the message can name the right box', () => {
    expect(disabledReason({ enabled: true, config: { enabled: false } }, configSchema)).toBe(
      'config',
    );
  });

  test('both on means not disabled', () => {
    expect(disabledReason({ enabled: true, config: { enabled: true } }, configSchema)).toBeNull();
  });

  test('config that will not parse is not reported as disabled', () => {
    expect(disabledReason({ enabled: true, config: { enabled: 'yes' } }, configSchema)).toBeNull();
  });
});
