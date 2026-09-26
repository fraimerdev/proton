import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionKind,
  type ActionRequest,
  type ActionResult,
  DefaultActionExecutor,
  EMPTY_MESSAGE,
  type EventBus,
  type GuildState,
  type ModuleManifest,
  ModuleRegistry,
  type ProtonEvent,
  resolvePrecheckContext,
  type SimulationAdapter,
  type SimulationDelivery,
  type SimulationOutcome,
  type SimulationRequestedPayload,
  type SimulationResults,
  simulationOutcomeSchema,
} from '@proton/core';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import { z } from 'zod';
import { SimulationConsumer } from '../src/simulation-consumer.ts';

const GUILD = '900000000000000001';
const ADMIN = '100000000000000001';
const CHANNEL = '300000000000000001';
const DM = '600000000000000001';
const MESSAGE = '700000000000000001';
const MODULE = 'greeter';

const PERMISSION_SENTENCE =
  'Discord says Proton is missing the Send Messages permission in that channel.';

function adapter(delivery: SimulationDelivery): SimulationAdapter {
  return {
    descriptor: {
      id: 'greeting',
      moduleId: MODULE,
      label: 'Greeting',
      summary: 'The message a new member gets.',
      configPath: 'greeting',
      output: 'message',
      delivery,
      subject: true,
      inputs: [],
    },
    build: () => ({
      ok: true,
      output: {
        kind: 'message',
        message: { ...EMPTY_MESSAGE, content: 'Welcome aboard!' },
        attachments: [],
      },
      diagnostics: [],
      caption: 'A greeting',
    }),
  };
}

function registryFor(delivery: SimulationDelivery): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register({
    id: MODULE,
    name: 'Greeter',
    category: 'engagement',
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    defaultConfig: { enabled: true },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    actionKinds: ['send', 'create_dm'],
    simulations: [adapter(delivery)],
  } as ModuleManifest);
  return registry;
}

function scripted(script: Partial<Record<ActionKind, ActionResult>>): {
  executor: ActionExecutor;
  requests: ActionRequest[];
} {
  const requests: ActionRequest[] = [];
  return {
    requests,
    executor: {
      async execute(request) {
        requests.push(request);
        const result = script[request.kind];
        if (result === undefined) throw new Error(`the test did not expect a ${request.kind}`);
        return result;
      },
    },
  };
}

const bus: EventBus = {
  async publish() {},
  subscribe() {
    throw new Error('these tests call handle() directly');
  },
};

const placeholders: PlaceholderEnvironment = {
  applicationId: '200000000000000001',
  bot: async () => ({ id: '200000000000000001', name: 'Proton', supportUrl: 'https://prtn.xyz' }),
  server: async (id) => ({ id }),
  user: async () => null,
  now: () => 0,
};

async function handled(
  delivery: SimulationDelivery,
  script: Partial<Record<ActionKind, ActionResult>>,
  kept: SimulationOutcome | null = null,
  real?: ActionExecutor,
): Promise<{ answers: SimulationOutcome[]; requests: ActionRequest[] }> {
  const { executor, requests } = real ? { executor: real, requests: [] } : scripted(script);
  const answers: SimulationOutcome[] = [];

  const results: SimulationResults = {
    recall: async () => kept,
    answer: async (_requestId, outcome) => {
      answers.push(outcome);
    },
    wait: async () => null,
  };

  const consumer = new SimulationConsumer({
    bus,
    results,
    registry: registryFor(delivery),
    executor,
    guildState: { get: async () => null },
    rest: {
      request: async () => ({
        status: 200,
        body: { user: { id: ADMIN, username: 'admin' }, roles: [] },
      }),
    },
    placeholders,
    apiUrl: 'http://api.invalid',
    apiSecret: 'secret',
    logger: { info() {}, warn() {}, error() {} },
    now: () => 0,
  });

  const payload: SimulationRequestedPayload = {
    requestId: 'request-0001',
    guildId: GUILD,
    moduleId: MODULE,
    simulationId: 'greeting',
    mode: 'send',
    actorId: ADMIN,
    subjectId: ADMIN,
    channelId: delivery === 'channel' ? CHANNEL : null,
    inputs: {},
    config: { enabled: true },
    tier: 'free',
    usedDraft: false,
  };

  const event: ProtonEvent = {
    id: `proton.simulation_requested:${GUILD}:request-0001`,
    type: 'proton.simulation_requested',
    guildId: GUILD,
    occurredAt: 0,
    payload,
  };

  await consumer.handle(event);

  return { answers, requests };
}

async function rehearse(
  delivery: SimulationDelivery,
  script: Partial<Record<ActionKind, ActionResult>>,
): Promise<{ outcome: SimulationOutcome; requests: ActionRequest[] }> {
  const { answers, requests } = await handled(delivery, script);

  expect(answers).toHaveLength(1);
  const [outcome] = answers;
  if (outcome === undefined) throw new Error('the consumer answered nothing');

  return { outcome: simulationOutcomeSchema.parse(outcome), requests };
}

const refused = (humanReason: string): ActionResult => ({
  status: 'failed_api',
  failure: { code: 'discord_403', humanReason },
});

const unreachable: ActionResult = {
  status: 'failed_api',
  failure: {
    code: 'transport_failure',
    humanReason: "I couldn't reach Discord. That may not have gone through.",
  },
};

const ALREADY_STARTED = {
  code: 'already_started',
  message:
    'Proton already started this test, so it stopped rather than risk sending it twice. Run ' +
    'the test again to send a new one.',
};

describe('a test message sent to direct messages', () => {
  test('a 403 on the send is the privacy setting, never a missing permission', async () => {
    const { outcome, requests } = await rehearse('dm', {
      create_dm: { status: 'executed', body: { id: 'dm1' } },
      send: refused(PERMISSION_SENTENCE),
    });

    expect(requests.map((request) => request.kind)).toEqual(['create_dm', 'send']);
    expect(requests[1]?.payload).toMatchObject({ channelId: 'dm1' });

    expect(outcome.ok).toBe(false);
    expect(outcome.sent).toBeNull();
    expect(outcome.error?.code).toBe('dm_closed');
    expect(outcome.error?.message).toContain("this server's privacy settings");
    expect(outcome.error?.message).toContain('blocked Proton');
    expect(outcome.error?.message).not.toMatch(/permission/i);
  });

  test('a 403 opening the conversation is the same refusal, and nothing is sent', async () => {
    const { outcome, requests } = await rehearse('dm', { create_dm: refused(PERMISSION_SENTENCE) });

    expect(requests.map((request) => request.kind)).toEqual(['create_dm']);
    expect(outcome.error?.code).toBe('dm_closed');
    expect(outcome.error?.message).toContain("this server's privacy settings");
    expect(outcome.error?.message).not.toMatch(/permission/i);
    expect(outcome.error?.message).not.toContain('Discord said');
  });

  test.each([50007, 50278])(
    'a 403 whose code %d says the DM cannot be delivered is the privacy setting',
    async (discordCode) => {
      const { outcome } = await rehearse('dm', {
        create_dm: { status: 'executed', body: { id: 'dm1' } },
        send: {
          status: 'failed_api',
          failure: { code: 'discord_403', humanReason: 'Discord refused.', discordCode },
        },
      });

      expect(outcome.error?.code).toBe('dm_closed');
    },
  );

  test('a 403 with another code on the send gives its reason and no privacy advice', async () => {
    const { outcome } = await rehearse('dm', {
      create_dm: { status: 'executed', body: { id: 'dm1' } },
      send: {
        status: 'failed_api',
        failure: {
          code: 'discord_403',
          humanReason: 'Discord has temporarily stopped Proton sending messages.',
          discordCode: 40004,
        },
      },
    });

    expect(outcome.error?.code).toBe('delivery_failed');
    expect(outcome.error?.message).toBe(
      "The test message wasn't posted: Discord has temporarily stopped Proton sending messages.",
    );
    expect(outcome.error?.message).not.toContain("this server's privacy settings");
  });

  test('a 403 with another code opening the conversation gives its reason and no privacy advice', async () => {
    const { outcome, requests } = await rehearse('dm', {
      create_dm: {
        status: 'failed_api',
        failure: {
          code: 'discord_403',
          humanReason: 'Discord says Proton lacks access.',
          discordCode: 50001,
        },
      },
    });

    expect(requests.map((request) => request.kind)).toEqual(['create_dm']);
    expect(outcome.error?.code).toBe('delivery_failed');
    expect(outcome.error?.message).toBe(
      "Proton couldn't open a DM with you, so nothing was sent. " +
        'Discord says Proton lacks access.',
    );
  });

  test('any other failure opening the conversation gives its reason and no privacy advice', async () => {
    const { outcome } = await rehearse('dm', {
      create_dm: {
        status: 'failed_api',
        failure: {
          code: 'discord_400',
          humanReason: 'Discord refused with 400: Invalid Recipient.',
        },
      },
    });

    expect(outcome.error?.code).toBe('delivery_failed');
    expect(outcome.error?.message).toBe(
      "Proton couldn't open a DM with you, so nothing was sent. " +
        'Discord refused with 400: Invalid Recipient.',
    );
  });

  test('a replayed request that finds the conversation already opened says only that it stopped', async () => {
    const { outcome, requests } = await rehearse('dm', {
      create_dm: { status: 'skipped_duplicate' },
    });

    expect(requests.map((request) => request.kind)).toEqual(['create_dm']);
    expect(outcome.sent).toBeNull();
    expect(outcome.error).toEqual(ALREADY_STARTED);
  });

  test('a conversation Discord opened without naming it is not called a failure to open one', async () => {
    const { outcome, requests } = await rehearse('dm', {
      create_dm: { status: 'executed', body: {} },
    });

    expect(requests.map((request) => request.kind)).toEqual(['create_dm']);
    expect(outcome.error).toEqual({
      code: 'delivery_failed',
      message:
        "Discord opened a DM with you but didn't say which channel it was, so nothing was sent.",
    });
  });

  test('Proton not reaching Discord to open the conversation says nothing was sent', async () => {
    const { outcome, requests } = await rehearse('dm', { create_dm: unreachable });

    expect(requests.map((request) => request.kind)).toEqual(['create_dm']);
    expect(outcome.error).toEqual({
      code: 'delivery_failed',
      message:
        "Proton couldn't reach Discord to open a DM with you, so nothing was sent. Try again in a " +
        'moment.',
    });
  });

  test('a send that may have landed says so and points at the direct messages', async () => {
    const { outcome } = await rehearse('dm', {
      create_dm: { status: 'executed', body: { id: 'dm1' } },
      send: unreachable,
    });

    expect(outcome.sent).toBeNull();
    expect(outcome.error).toEqual({
      code: 'delivery_failed',
      message:
        "Proton couldn't reach Discord, so it can't tell whether the test message was posted. " +
        'Check your DMs before trying again.',
    });
  });

  test('a send failing with anything but a 403 keeps the reason Discord gave', async () => {
    const { outcome } = await rehearse('dm', {
      create_dm: { status: 'executed', body: { id: 'dm1' } },
      send: {
        status: 'failed_api',
        failure: { code: 'discord_404', humanReason: 'Discord no longer has that channel.' },
      },
    });

    expect(outcome.error).toEqual({
      code: 'delivery_failed',
      message: "The test message wasn't posted: Discord no longer has that channel.",
    });
  });

  test('a delivered test answers with the message it sent and no link', async () => {
    const { outcome } = await rehearse('dm', {
      create_dm: { status: 'executed', body: { id: 'dm1' } },
      send: { status: 'executed', body: { id: 'message1' } },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.sent).toMatchObject({ channelId: 'dm1', messageId: 'message1', url: null });
  });

  test('the send is marked as a direct message, so no server permission is asked of it', async () => {
    const { requests } = await rehearse('dm', {
      create_dm: { status: 'executed', body: { id: 'dm1' } },
      send: { status: 'executed', body: { id: 'message1' } },
    });

    expect(requests[1]?.payload).toMatchObject({ channelId: 'dm1', directMessage: true });
  });

  const grantsNothing: GuildState = {
    guildId: GUILD,
    ownerId: ADMIN,
    everyoneRoleId: GUILD,
    roles: new Map([[GUILD, { id: GUILD, permissions: 0n, position: 0 }]]),
    botRoleIds: [],
    channels: new Map(),
    updatedAt: 0,
  };

  test.each([
    ['from a server that grants Proton nothing', grantsNothing],
    ['before Proton has this server’s state', null],
  ])('reaches the admin %s, which a DM does not need', async (_, state) => {
    const calls: string[] = [];
    const claimed = new Set<string>();

    const executor = new DefaultActionExecutor({
      dedupe: {
        claim: async (key) => {
          if (claimed.has(key)) return false;
          claimed.add(key);
          return true;
        },
        release: async (key) => {
          claimed.delete(key);
        },
        has: async (key) => claimed.has(key),
      },
      rest: {
        request: async ({ method, path }) => {
          calls.push(`${method} ${path}`);
          return { status: 200, body: { id: path === '/users/@me/channels' ? DM : MESSAGE } };
        },
      },
      recorder: { record: async () => ({ caseId: 'case' }) },
      resolveContext: async (request) => {
        const resolved = await resolvePrecheckContext(
          {
            store: {
              get: async () => state,
              put: async () => undefined,
              patch: async () => undefined,
              delete: async () => undefined,
            },
            botUserId: '200000000000000001',
          },
          request,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    });

    const { answers } = await handled('dm', {}, null, executor);
    const [outcome] = answers;

    expect(calls).toEqual(['POST /users/@me/channels', `POST /channels/${DM}/messages`]);
    expect(outcome?.error).toBeNull();
    expect(outcome?.sent).toMatchObject({ channelId: DM, messageId: MESSAGE, url: null });
  });
});

describe('a test message sent to a channel', () => {
  test('a 403 on the send is a delivery failure carrying the reason', async () => {
    const { outcome, requests } = await rehearse('channel', { send: refused(PERMISSION_SENTENCE) });

    expect(requests.map((request) => request.kind)).toEqual(['send']);
    expect(requests[0]?.payload).toMatchObject({ channelId: CHANNEL, directMessage: false });
    expect(outcome.error).toEqual({
      code: 'delivery_failed',
      message: `The test message wasn't posted: ${PERMISSION_SENTENCE}`,
    });
  });

  test('a send that may have landed never claims it was not posted', async () => {
    const { outcome } = await rehearse('channel', { send: unreachable });

    expect(outcome.error).toEqual({
      code: 'delivery_failed',
      message:
        "Proton couldn't reach Discord, so it can't tell whether the test message was posted. " +
        `Check <#${CHANNEL}> before trying again.`,
    });
  });

  test('a replayed send the first run already claimed is not reported as delivered', async () => {
    const { outcome } = await rehearse('channel', { send: { status: 'skipped_duplicate' } });

    expect(outcome.ok).toBe(false);
    expect(outcome.sent).toBeNull();
    expect(outcome.error).toEqual(ALREADY_STARTED);
  });
});

describe('a request delivered again after it was answered', () => {
  test('runs nothing and leaves the first answer standing', async () => {
    const first: SimulationOutcome = {
      ok: true,
      mode: 'send',
      simulationId: 'greeting',
      usedDraft: false,
      destination: { kind: 'channel', channelId: CHANNEL, label: `<#${CHANNEL}>` },
      render: null,
      sent: { channelId: CHANNEL, messageId: 'message1', url: null, markerOmitted: null },
      error: null,
    };

    const { answers, requests } = await handled('channel', {}, first);

    expect(requests).toEqual([]);
    expect(answers).toEqual([]);
  });
});
