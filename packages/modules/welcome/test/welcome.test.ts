import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  Attachment,
  CaseInput,
  CaseRecorder,
  DedupeStore,
  Logger,
  PrecheckInput,
  ProtonEvent,
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '@proton/core';
import {
  DefaultActionExecutor,
  ModuleRegistry,
  newId,
  Permissions,
  requiredPermissionsFor,
} from '@proton/core';
import { SAMPLE_NOW } from '@proton/core/placeholders';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { GatewayIntentBits } from 'discord-api-types/v10';
import type { WelcomeConfig } from '../src/config.ts';
import {
  DEFAULT_BOOST_MESSAGE,
  DEFAULT_GOODBYE_MESSAGE,
  DEFAULT_WELCOME_MESSAGE,
  type GreetingMessage,
  greetingMessageSchema,
  isSilentGreeting,
  welcomeConfigSchema,
  welcomeDefaultConfig,
  welcomeFormSchema,
} from '../src/config.ts';
import { createWelcomeModule, welcomeModule } from '../src/index.ts';
import {
  createBoostListener,
  createGreetingListener,
  readGreetingTarget,
} from '../src/listeners.ts';
import {
  type GreetingPlaceholderFacts,
  renderGreetingMessage,
  WELCOME_JOIN_SURFACE,
} from '../src/placeholders.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const MEMBER = '100000000000000002';
const BOOSTER = '100000000000000001';
const NOTICE_CHANNEL = '500000000000000009';
const BOOST_CHANNEL = '500000000000000002';

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

function config(overrides: Record<string, unknown> = {}): WelcomeConfig {
  return welcomeConfigSchema.parse({
    enabled: true,
    welcomeChannelId: CHANNEL,
    goodbyeChannelId: CHANNEL,
    ...overrides,
  });
}

function greeting(value: unknown): GreetingMessage {
  return greetingMessageSchema.parse(value);
}

function joinEvent(): ProtonEvent {
  const event = normalise(dispatch('guildMemberAdd'))[0];
  if (!event) throw new Error('guildMemberAdd did not normalise');
  return event;
}

function leaveEvent(): ProtonEvent {
  const raw = dispatch('guildMemberAdd');
  raw.t = 'GUILD_MEMBER_REMOVE';
  const event = normalise(raw)[0];
  if (!event) throw new Error('GUILD_MEMBER_REMOVE did not normalise');
  return event;
}

function boostEvent(type: number, d: Record<string, unknown> = {}): ProtonEvent {
  const raw = dispatch('messageCreate');
  raw.d = { ...raw.d, type, content: '', channel_id: NOTICE_CHANNEL, ...d };
  const event = normalise(raw)[0];
  if (!event) throw new Error('MESSAGE_CREATE did not normalise');
  return event;
}

class MemoryDedupe implements DedupeStore {
  readonly #claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.#claimed.has(key)) return false;
    this.#claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.#claimed.has(key);
  }
}

class MemoryRecorder implements CaseRecorder {
  async record(_input: CaseInput): Promise<{ caseId: string }> {
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return { status: 200, body: {} };
  }
}

function prechecked(botChannelPermissions: bigint): {
  executor: ActionExecutor;
  rest: FakeRest;
} {
  const rest = new FakeRest();
  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder: new MemoryRecorder(),
    resolveContext: async (request): Promise<PrecheckInput> => {
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      return {
        guildId: GUILD,
        guildOwnerId: '200000000000000001',
        botUserId: '300000000000000001',
        botHighestRolePosition: 10,
        botChannelPermissions,
        requiredPermissions: requiredPermissionsFor(request.kind, request.payload),
        ...(typeof payload.channelId === 'string' ? { channelId: payload.channelId } : {}),
      };
    },
  });

  return { executor, rest };
}

describe('renderGreetingMessage', () => {
  const facts: GreetingPlaceholderFacts = {
    user: { id: MEMBER, username: 'Newcomer', globalName: null, avatarHash: null },
    member: { nick: null },
    server: { id: GUILD, name: 'Proton', memberCount: 42 },
    destinationChannel: { id: CHANNEL },
    bot: null,
    eventId: 'join-1',
    occurredAt: SAMPLE_NOW,
  };

  function rendered(
    message: GreetingMessage,
    given: GreetingPlaceholderFacts = facts,
  ): GreetingMessage {
    const result = renderGreetingMessage(message, WELCOME_JOIN_SURFACE, given, SAMPLE_NOW);
    if (!result.ok) throw new Error(result.humanReason);
    return result.message;
  }

  function content(template: string): string | undefined {
    return rendered(greeting(template)).content;
  }

  test('substitutes every placeholder', () => {
    expect(content('{user} {username} {server} {memberCount}')).toBe(
      `<@${MEMBER}> Newcomer Proton 42`,
    );
  });

  test('{user} is a mention, so it pings and renders any display name', () => {
    expect(content('{user}')).toBe(`<@${MEMBER}>`);
  });

  test('leaves unknown tokens alone rather than blanking them', () => {
    expect(content('hello {nobody}')).toBe('hello {nobody}');
  });

  test('a token naming an Object.prototype member is left alone, not resolved to it', () => {
    expect(content('hello {constructor}')).toBe('hello {constructor}');
  });

  test('a substituted value is not itself expanded', () => {
    const hostile = { ...facts, user: { ...facts.user, username: '{server}' } };

    expect(rendered(greeting('{username}'), hostile).content).toBe('{server}');
  });

  test('truncates to Discord’s 2000-character limit rather than sending nothing', () => {
    const huge = { ...facts, server: { id: GUILD, name: 'P'.repeat(3000), memberCount: 42 } };

    expect(rendered(greeting('Welcome to {server}'), huge).content).toHaveLength(2000);
  });

  test('substitutes inside an embed, not only in the content', () => {
    const embedded = rendered(
      greeting({
        embeds: [
          {
            title: 'Welcome to {server}',
            description: 'Say hello to {username}',
            fields: [{ name: 'Member', value: 'You are #{memberCount}' }],
          },
        ],
      }),
    );

    expect(embedded.embeds[0]?.title).toBe('Welcome to Proton');
    expect(embedded.embeds[0]?.description).toBe('Say hello to Newcomer');
    expect(embedded.embeds[0]?.fields?.[0]?.value).toBe('You are #42');
  });

  test('leaves the stored message untouched, so the next join renders the tokens again', () => {
    const stored = greeting('Welcome to {server}');

    rendered(stored);

    expect(stored.content).toBe('Welcome to {server}');
  });
});

describe('a greeting stored before it could hold an embed', () => {
  test('a bare string comes back as the content of a message', () => {
    expect(greeting('Welcome to {server}!')).toEqual({
      content: 'Welcome to {server}!',
      embeds: [],
      components: [],
      mentions: { everyone: false, roles: true, users: true },
      v2: [],
    });
  });

  // The bug this closes: the sidebar switch saves { enabled } with no config, and the API falls
  // back to the parsed config it read. A string that did not survive the parse would be gone.
  test('it survives a parse and a re-parse with its text intact', () => {
    const once = greeting('Welcome to {server}!');
    const twice = greeting(once);

    expect(twice).toEqual(once);
    expect(twice.content).toBe('Welcome to {server}!');
  });

  test('a whole stored config round-trips through the schema without losing either message', () => {
    const stored = {
      enabled: true,
      welcomeChannelId: CHANNEL,
      welcomeMessage: 'Welcome to {server}!',
      goodbyeMessage: 'Bye {username}.',
      card: true,
    };

    const once = welcomeConfigSchema.parse(stored);
    const twice = welcomeConfigSchema.parse(once);

    expect(twice.welcomeMessage.content).toBe('Welcome to {server}!');
    expect(twice.goodbyeMessage.content).toBe('Bye {username}.');
    expect(twice).toEqual(once);
  });

  test('an empty string stays an empty message rather than failing to parse', () => {
    const empty = greeting('');

    expect(isSilentGreeting(empty)).toBe(true);
    expect(greeting(empty)).toEqual(empty);
  });

  test('the defaults are the same messages, in the new shape', () => {
    expect(welcomeDefaultConfig.welcomeMessage.content).toBe(DEFAULT_WELCOME_MESSAGE);
    expect(welcomeDefaultConfig.goodbyeMessage.content).toBe(DEFAULT_GOODBYE_MESSAGE);
    expect(welcomeDefaultConfig.boostMessage.content).toBe(DEFAULT_BOOST_MESSAGE);
  });
});

describe('a config stored before boosts existed', () => {
  const stored = {
    enabled: true,
    welcomeChannelId: CHANNEL,
    welcomeMessage: 'Welcome to {server}!',
    goodbyeChannelId: CHANNEL,
    goodbyeMessage: 'Bye {username}.',
    card: true,
    preset: 'midnight',
  };

  test('parses, with boosts off, no boost channel and the default thanks', () => {
    const parsed = welcomeConfigSchema.parse(stored);

    expect(parsed.boostEnabled).toBe(false);
    expect(parsed.boostChannelId).toBeUndefined();
    expect(parsed.boostMessage.content).toBe(DEFAULT_BOOST_MESSAGE);
  });

  test('keeps every key it already had', () => {
    const parsed = welcomeConfigSchema.parse(stored);

    expect(parsed.welcomeChannelId).toBe(CHANNEL);
    expect(parsed.welcomeMessage.content).toBe('Welcome to {server}!');
    expect(parsed.goodbyeMessage.content).toBe('Bye {username}.');
    expect(parsed.card).toBe(true);
    expect(welcomeConfigSchema.parse(parsed)).toEqual(parsed);
  });
});

describe('what a greeting refuses', () => {
  test('a button Proton would have to answer, because nothing here listens for the press', () => {
    const refused = greetingMessageSchema.safeParse({
      content: 'Hello',
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'hi', label: 'Hi', style: 'primary', action: { kind: 'reply', content: 'Hi' } },
          ],
        },
      ],
    });

    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain('link buttons and nothing else');
  });

  test('a dropdown, for the same reason', () => {
    const refused = greetingMessageSchema.safeParse({
      content: 'Hello',
      components: [
        {
          kind: 'select',
          select: { key: 'pick', options: [{ key: 'one', label: 'One' }] },
        },
      ],
    });

    expect(refused.success).toBe(false);
  });

  // A link button never reaches Proton — Discord opens the address itself — so it is the one
  // component that works on a message nothing is listening to.
  test('but not a link button', () => {
    const accepted = greetingMessageSchema.safeParse({
      content: 'Hello',
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'rules', label: 'Read the rules', style: 'link', url: 'https://example.com' },
          ],
        },
      ],
    });

    expect(accepted.success).toBe(true);
  });

  test('an embed with nothing in it', () => {
    expect(greetingMessageSchema.safeParse({ embeds: [{}] }).success).toBe(false);
  });
});

describe('the generated form', () => {
  test('omits the three messages, which the message builder panel edits instead', () => {
    expect(Object.keys(welcomeFormSchema.shape).sort()).toEqual([
      'boostChannelId',
      'boostEnabled',
      'card',
      'cardAccent',
      'cardBackgroundUrl',
      'cardShowMemberCount',
      'enabled',
      'goodbyeChannelId',
      'preset',
      'welcomeChannelId',
    ]);
  });
});

describe('readGreetingTarget', () => {
  test('reads the user from a member dispatch', () => {
    const target = readGreetingTarget(joinEvent().payload);

    expect(target?.userId).toBe(MEMBER);
    expect(target?.username).toBe('Newcomer');
  });

  // The bug this closes: these came off the dispatch, which carries neither, so every guild's
  // welcome said "this server" and "#0" no matter what.
  test('takes the guild name and member count from the guild-state cache', () => {
    const target = readGreetingTarget(joinEvent().payload, { name: 'Proton', memberCount: 42 });

    expect(target?.guildName).toBe('Proton');
    expect(target?.memberCount).toBe(42);
  });

  test('degrades gracefully when the cache has nothing yet', () => {
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

  test('posts the embed the guild built, with its placeholders already substituted', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener({
      guildState: { get: async () => ({ name: 'Proton', memberCount: 42 }) },
    });

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({
        welcomeMessage: {
          content: 'Hey {user}',
          embeds: [{ title: 'Welcome to {server}', description: 'Member #{memberCount}' }],
        },
      }),
      executor,
      logger: collectingLogger().logger,
    });

    const payload = payloadOf(executor);
    const embeds = payload.embeds as Array<Record<string, unknown>> | undefined;

    expect(payload.content).toBe(`Hey <@${MEMBER}>`);
    expect(embeds?.[0]?.title).toBe('Welcome to Proton');
    expect(embeds?.[0]?.description).toBe('Member #42');
  });

  // Discord parses every mention in a bot message by default, so a greeting built from a name a
  // member picked could otherwise ping the whole server.
  test('always names what may be mentioned', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener();

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config(),
      executor,
      logger: collectingLogger().logger,
    });

    expect(payloadOf(executor).allowedMentions).toEqual({ parse: ['roles', 'users'] });
  });

  test('a link button is posted with its address, and never asks for a custom_id', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener();

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({
        welcomeMessage: {
          content: 'Hello',
          components: [
            {
              kind: 'buttons',
              buttons: [
                { key: 'rules', label: 'Read the rules', style: 'link', url: 'https://ex.com' },
              ],
            },
          ],
        },
      }),
      executor,
      logger: collectingLogger().logger,
    });

    const rows = payloadOf(executor).components as Array<{
      components: Array<Record<string, unknown>>;
    }>;

    expect(rows[0]?.components[0]?.url).toBe('https://ex.com');
    expect(rows[0]?.components[0]?.custom_id).toBeUndefined();
  });

  test('an empty message with no card says nothing, and reports nothing', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const listener = createGreetingListener();

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({ welcomeMessage: '' }),
      executor,
      logger,
    });

    expect(executor.requests).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('an empty message still posts the card on its own', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener({ render: async () => new Uint8Array([137, 80]) });

    await listener.handler(joinEvent(), {
      guildId: GUILD,
      config: config({ welcomeMessage: '', card: true }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(payloadOf(executor).content).toBeUndefined();
    expect(payloadOf(executor).files).toHaveLength(1);
  });
});

describe('boost listener', () => {
  function boostConfig(overrides: Record<string, unknown> = {}): WelcomeConfig {
    return config({ boostEnabled: true, ...overrides });
  }

  const proton = { get: async () => ({ name: 'Proton', memberCount: 42 }) };

  test('thanks the booster for a boost notice', async () => {
    const executor = new RecordingExecutor();
    const listener = createBoostListener({ guildState: proton });
    const event = boostEvent(8);

    await listener.handler(event, {
      guildId: GUILD,
      config: boostConfig(),
      executor,
      logger: collectingLogger().logger,
    });

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.kind).toBe('send');
    expect(executor.requests[0]?.idempotencyKey).toBe(`${event.id}:boost`);
    expect(payloadOf(executor).content).toBe(`Thanks for boosting **Proton**, <@${BOOSTER}>!`);
    expect(payloadOf(executor).allowedMentions).toEqual({ parse: ['roles', 'users'] });
  });

  test('thanks the booster when the boost also reached a new level', async () => {
    const executor = new RecordingExecutor();
    const listener = createBoostListener({ guildState: proton });

    await listener.handler(boostEvent(10), {
      guildId: GUILD,
      config: boostConfig({ boostMessage: '{username} boosted {server} to #{memberCount}' }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(executor.requests).toHaveLength(1);
    expect(payloadOf(executor).content).toBe('Tester boosted Proton to #42');
  });

  test('posts where Discord posted its boost notice when no boost channel is set', async () => {
    const executor = new RecordingExecutor();

    await createBoostListener().handler(boostEvent(8), {
      guildId: GUILD,
      config: boostConfig(),
      executor,
      logger: collectingLogger().logger,
    });

    expect(payloadOf(executor).channelId).toBe(NOTICE_CHANNEL);
  });

  test('posts in the boost channel when one is set', async () => {
    const executor = new RecordingExecutor();

    await createBoostListener().handler(boostEvent(9), {
      guildId: GUILD,
      config: boostConfig({ boostChannelId: BOOST_CHANNEL }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(payloadOf(executor).channelId).toBe(BOOST_CHANNEL);
  });

  test('names the booster by their server nickname when the notice carries one', async () => {
    const executor = new RecordingExecutor();

    await createBoostListener().handler(
      boostEvent(11, { member: { nick: 'Sparkle', roles: [] } }),
      {
        guildId: GUILD,
        config: boostConfig({ boostMessage: 'Thank you, {username}' }),
        executor,
        logger: collectingLogger().logger,
      },
    );

    expect(payloadOf(executor).content).toBe('Thank you, Sparkle');
  });

  test('never attaches a card, even with welcome cards on', async () => {
    const executor = new RecordingExecutor();
    let renders = 0;
    const listener = createBoostListener({
      render: async () => {
        renders += 1;
        return new Uint8Array([137, 80]);
      },
    });

    await listener.handler(boostEvent(8), {
      guildId: GUILD,
      config: boostConfig({ card: true }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(payloadOf(executor).files).toBeUndefined();
    expect(renders).toBe(0);
  });

  test('an ordinary message and a reply are not boosts, and cost no cache lookup', async () => {
    const executor = new RecordingExecutor();
    let lookups = 0;
    const listener = createBoostListener({
      guildState: {
        get: async () => {
          lookups += 1;
          return {};
        },
      },
    });
    const ctx = {
      guildId: GUILD,
      config: boostConfig(),
      executor,
      logger: collectingLogger().logger,
    };

    await listener.handler(boostEvent(0), ctx);
    await listener.handler(boostEvent(19), ctx);

    expect(executor.requests).toEqual([]);
    expect(lookups).toBe(0);
  });

  test('a boost notice with a bot as its author is ignored', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();

    await createBoostListener().handler(
      boostEvent(8, { author: { id: BOOSTER, username: 'robot', bot: true } }),
      { guildId: GUILD, config: boostConfig(), executor, logger },
    );

    expect(executor.requests).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('switched off, a boost posts nothing', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();

    await createBoostListener().handler(boostEvent(8), {
      guildId: GUILD,
      config: config(),
      executor,
      logger,
    });

    expect(executor.requests).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('an empty boost message says nothing', async () => {
    const executor = new RecordingExecutor();

    await createBoostListener().handler(boostEvent(8), {
      guildId: GUILD,
      config: boostConfig({ boostMessage: '' }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(executor.requests).toEqual([]);
  });

  test('a channel Proton cannot send in is reported with the permission and the channel', async () => {
    const { executor, rest } = prechecked(Permissions.ViewChannel);
    const { logger, lines } = collectingLogger();

    await createBoostListener().handler(boostEvent(8), {
      guildId: GUILD,
      config: boostConfig({ boostChannelId: BOOST_CHANNEL }),
      executor,
      logger,
    });

    expect(rest.calls).toEqual([]);
    expect(lines.join(' ')).toContain(
      `I'm missing the Send Messages permission in <#${BOOST_CHANNEL}>`,
    );
  });

  test('a redelivered boost notice is sent once', async () => {
    const { executor, rest } = prechecked(Permissions.ViewChannel | Permissions.SendMessages);
    const listener = createBoostListener();
    const ctx = {
      guildId: GUILD,
      config: boostConfig(),
      executor,
      logger: collectingLogger().logger,
    };

    await listener.handler(boostEvent(9), ctx);
    await listener.handler(boostEvent(9), ctx);

    expect(rest.calls).toHaveLength(1);
    expect(rest.calls[0]?.path).toBe(`/channels/${NOTICE_CHANNEL}/messages`);
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
    expect(welcomeDefaultConfig.boostEnabled).toBe(false);
  });

  test('subscribes to the messages boost notices arrive as', () => {
    expect(welcomeModule.listeners?.flatMap((listener) => listener.types)).toContain(
      'message.created',
    );
  });

  test('every dashboard section names a field the form has', () => {
    const formKeys = new Set(Object.keys(welcomeFormSchema.shape));
    const fields = welcomeModule.dashboard?.sections.flatMap((section) => section.fields) ?? [];

    expect(fields).toContain('boostEnabled');
    expect(fields).toContain('boostChannelId');
    expect(fields.filter((field) => !formKeys.has(field))).toEqual([]);
  });

  test('reports a missing Guild Messages intent, which boost notices need', () => {
    const registry = new ModuleRegistry();
    registry.register(welcomeModule);

    const status = registry.evaluate('welcome', {
      grantedIntents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers,
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.humanReason).toContain('Guild Messages');
  });

  test('reports the missing privileged intent by name', () => {
    const registry = new ModuleRegistry();
    registry.register(welcomeModule);

    const status = registry.evaluate('welcome', {
      grantedIntents: GatewayIntentBits.Guilds,
      botPermissions: Permissions.ViewChannel | Permissions.SendMessages,
    });

    expect(status.enabled).toBe(false);
    expect(status.disabledReason?.humanReason).toContain('Server Members Intent');
  });

  test('reports a missing send permission by name', () => {
    const registry = new ModuleRegistry();
    registry.register(welcomeModule);

    const status = registry.evaluate('welcome', {
      grantedIntents:
        GatewayIntentBits.Guilds | GatewayIntentBits.GuildMembers | GatewayIntentBits.GuildMessages,
      botPermissions: Permissions.ViewChannel,
    });

    expect(status.disabledReason?.humanReason).toContain('Send Messages');
  });
});
