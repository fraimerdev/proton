import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  Attachment,
  Logger,
  ProtonEvent,
} from '@proton/core';
import { ModuleRegistry, Permissions } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  DEFAULT_GOODBYE_MESSAGE,
  renderGreeting,
  type WelcomeConfig,
  welcomeConfigSchema,
  welcomeDefaultConfig,
} from '../src/config.ts';
import { createWelcomeModule, welcomeModule } from '../src/index.ts';
import { createGreetingListener, readGreetingTarget } from '../src/listeners.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const MEMBER = '100000000000000002';

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  result: ActionResult = { status: 'executed', caseId: 'case-1' };

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return this.result;
  }
}

function payloadOf(executor: RecordingExecutor): Record<string, unknown> {
  const request = executor.requests[0];
  if (!request) throw new Error('no action was executed');
  return (request.payload ?? {}) as Record<string, unknown>;
}

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

function config(overrides: Partial<WelcomeConfig> = {}): WelcomeConfig {
  return welcomeConfigSchema.parse({
    enabled: true,
    welcomeChannelId: CHANNEL,
    goodbyeChannelId: CHANNEL,
    ...overrides,
  });
}

function joinEvent(): ProtonEvent {
  const event = normalise(dispatch('guildMemberAdd'));
  if (!event) throw new Error('guildMemberAdd did not normalise');
  return event;
}

function leaveEvent(): ProtonEvent {
  const raw = dispatch('guildMemberAdd');
  raw.t = 'GUILD_MEMBER_REMOVE';
  const event = normalise(raw);
  if (!event) throw new Error('GUILD_MEMBER_REMOVE did not normalise');
  return event;
}

describe('renderGreeting', () => {
  const facts = { userId: MEMBER, username: 'Newcomer', guildName: 'Proton', memberCount: 42 };

  test('substitutes every placeholder', () => {
    expect(renderGreeting('{user} {username} {server} {memberCount}', facts)).toBe(
      `<@${MEMBER}> Newcomer Proton 42`,
    );
  });

  test('{user} is a mention, so it pings and renders any display name', () => {
    expect(renderGreeting('{user}', facts)).toBe(`<@${MEMBER}>`);
  });

  test('leaves unknown tokens alone rather than blanking them', () => {
    expect(renderGreeting('hello {nobody}', facts)).toBe('hello {nobody}');
  });

  test('a substituted value is not itself expanded', () => {
    const hostile = { ...facts, username: '{server}' };

    expect(renderGreeting('{username}', hostile)).toBe('{server}');
  });

  test('truncates to Discord’s 2000-character limit rather than sending nothing', () => {
    expect(renderGreeting('x'.repeat(3000), facts)).toHaveLength(2000);
  });
});

describe('readGreetingTarget', () => {
  test('reads the user from a member dispatch', () => {
    const target = readGreetingTarget(joinEvent().payload);

    expect(target?.userId).toBe(MEMBER);
    expect(target?.username).toBe('Newcomer');
  });

  test('degrades gracefully when the guild name is absent', () => {
    const target = readGreetingTarget(joinEvent().payload);

    expect(target?.guildName).toBe('this server');
    expect(target?.memberCount).toBe(0);
  });

  test('returns null when there is no user to greet', () => {
    expect(readGreetingTarget({ guild_id: GUILD })).toBeNull();
  });
});

describe('greeting listener', () => {
  test('sends a welcome on join', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener({ render: async () => new Uint8Array([1]) });

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config(),
      executor,
      logger: collectingLogger().logger,
    });

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.kind).toBe('send');
    expect(payloadOf(executor).channelId).toBe(CHANNEL);
  });

  test('sends a goodbye on leave, using the goodbye template', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener();

    await listener.handler(leaveEvent(), {
      guildId: GUILD,
      config: config({ goodbyeMessage: DEFAULT_GOODBYE_MESSAGE }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(String(payloadOf(executor).content)).toContain('Newcomer');
  });

  test('an unset channel means no greeting and no error', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const listener = createGreetingListener();

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({ welcomeChannelId: undefined }),
      executor,
      logger,
    });

    expect(executor.requests).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('attaches a card when the guild asked for one', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener({ render: async () => new Uint8Array([137, 80]) });

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({ card: true }),
      executor,
      logger: collectingLogger().logger,
    });

    const files = payloadOf(executor).files as Attachment[] | undefined;
    expect(files).toHaveLength(1);
    expect(files?.[0]?.filename).toBe('welcome.png');
    expect(files?.[0]?.contentType).toBe('image/png');
  });

  test('sends no attachment when cards are off', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener();

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({ card: false }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(payloadOf(executor).files).toBeUndefined();
  });

  test('a failed render still sends the message, and says why', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const listener = createGreetingListener({
      render: async () => {
        throw new Error('rasteriser unavailable');
      },
    });

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({ card: true }),
      executor,
      logger,
    });

    expect(executor.requests).toHaveLength(1);
    expect(payloadOf(executor).files).toBeUndefined();
    expect(lines.join(' ')).toContain('rasteriser unavailable');
  });

  test('a redelivered join reuses the same idempotency key', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener();
    const ctx = {
      guildId: GUILD,
      config: config(),
      executor,
      logger: collectingLogger().logger,
    };

    await listener.handler(joinEvent(), ctx);
    await listener.handler(joinEvent(), ctx);

    expect(executor.requests[0]?.idempotencyKey).toBe(executor.requests[1]?.idempotencyKey ?? '');
  });

  test('a refused send is reported with the executor’s own reason', async () => {
    const executor = new RecordingExecutor();
    executor.result = {
      status: 'failed_precheck',
      failure: { code: 'missing_permission', humanReason: 'I cannot post in that channel.' },
    };
    const { logger, lines } = collectingLogger();
    const listener = createGreetingListener();

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config(),
      executor,
      logger,
    });

    expect(lines.join(' ')).toContain('I cannot post in that channel.');
  });
});

describe('welcome manifest', () => {
  test('registers cleanly, so the dashboard can render it', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(welcomeModule)).not.toThrow();
    expect(registry.descriptors('welcome').length).toBeGreaterThan(0);
  });

  test('is a valid manifest with no renderer bound', () => {
    expect(() => new ModuleRegistry().register(createWelcomeModule())).not.toThrow();
  });

  test('defaults are off, so an unconfigured guild gets nothing', () => {
    expect(welcomeDefaultConfig.enabled).toBe(false);
    expect(welcomeDefaultConfig.card).toBe(false);
  });

  test('reports the missing privileged intent by name', () => {
    const registry = new ModuleRegistry();
    registry.register(welcomeModule);

    const status = registry.evaluate('welcome', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.humanReason).toContain('GuildMembers');
  });

  test('reports a missing send permission by name', () => {
    const registry = new ModuleRegistry();
    registry.register(welcomeModule);

    const status = registry.evaluate('welcome', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.disabledReason?.humanReason).toContain('SendMessages');
  });
});
