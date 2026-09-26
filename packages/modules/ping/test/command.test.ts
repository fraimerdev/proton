import { describe, expect, test } from 'bun:test';
import {
  type ActionExecutor,
  type ActionRequest,
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type Logger,
  MESSAGE_FLAG_EPHEMERAL,
  newId,
  Permissions,
  type PrecheckInput,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrivateReply,
  subcommandPath,
} from '@proton/core';
import { pingCommand } from '../src/command.ts';
import { type PingConfig, pingDefaultConfig } from '../src/config.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const USER = '100000000000000001';
const INTERACTION = '600000000000000001';
const LIVE_TOKEN = 'cGluZy1pbnRlcmFjdGlvbg.live.15-minutes';

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
  readonly recorded: CaseInput[] = [];

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
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

interface RunOverrides {
  replyPreference: boolean | null;
  // Present, it replaces what the worker would resolve — undefined is a worker that set none.
  privateReply: boolean | undefined;

  idempotencyKey: string;
}

function privateReplyOf(
  config: PingConfig,
  overrides: Partial<RunOverrides>,
): { privateReply?: boolean } {
  if ('privateReply' in overrides) {
    return overrides.privateReply === undefined ? {} : { privateReply: overrides.privateReply };
  }
  if (!pingCommand.reply) return {};

  const preference = overrides.replyPreference ?? null;
  return {
    privateReply: resolvePrivateReply(pingCommand.reply, config, subcommandPath([]), preference),
  };
}

function harness(config: Partial<PingConfig> = {}, overrides: Partial<RunOverrides> = {}) {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
  const requests: ActionRequest[] = [];
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder,
    resolveContext: async (): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: '200000000000000001',
      botUserId: '300000000000000001',
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
      requiredPermissions: 0n,
      channelId: CHANNEL,
    }),
  });

  const recording: ActionExecutor = {
    execute: (request) => {
      requests.push(request);
      return executor.execute(request);
    },
  };

  const full = { ...pingDefaultConfig, ...config };
  const ctx: CommandContext<PingConfig> = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: USER,
    config: full,
    executor: recording,
    logger,
    options: createCommandOptions([]),
    interaction: { id: INTERACTION, token: LIVE_TOKEN },
    idempotencyKey: overrides.idempotencyKey ?? newId(),
    ...privateReplyOf(full, overrides),
  };

  return { ctx, rest, recorder, requests, lines };
}

function ephemeralFlag(rest: FakeRest): number {
  const body = rest.calls[0]?.body as { data?: { flags?: number } } | undefined;
  return (body?.data?.flags ?? 0) & MESSAGE_FLAG_EPHEMERAL;
}

describe('/ping', () => {
  test('answers the invoker without opening a moderation case', async () => {
    const { ctx, rest, recorder } = harness();

    await pingCommand.handler(ctx);

    expect(rest.calls).toHaveLength(1);
    expect(rest.calls[0]?.path).toBe(`/interactions/${INTERACTION}/${LIVE_TOKEN}/callback`);
    expect(recorder.recorded).toEqual([]);
  });

  test('does not leak the interaction token into anything the ledger would keep', async () => {
    const { ctx, recorder } = harness();

    await pingCommand.handler(ctx);

    expect(JSON.stringify(recorder.recorded)).not.toContain(LIVE_TOKEN);
  });
});

describe('/ping reply visibility', () => {
  test('answers in public unless its own setting says otherwise', () => {
    expect(pingCommand.reply).toEqual({ default: 'public', toggleable: [''] });
  });

  test('with no setting it answers exactly as it always has, in public', async () => {
    const before = harness({}, { privateReply: undefined, idempotencyKey: 'evt-ping' });
    const after = harness({}, { replyPreference: null, idempotencyKey: 'evt-ping' });

    await pingCommand.handler(before.ctx);
    await pingCommand.handler(after.ctx);

    expect(after.ctx.privateReply).toBe(false);
    expect(after.requests).toEqual(before.requests);
    expect(after.requests.map((request) => request.payload)).toMatchObject([{ ephemeral: false }]);
    expect(after.requests[0]?.payload).not.toHaveProperty('callbackType');
    expect(ephemeralFlag(after.rest)).toBe(0);
  });

  test('set private, only the member who asked sees the answer', async () => {
    const { ctx, rest, requests } = harness({}, { replyPreference: true });

    await pingCommand.handler(ctx);

    expect(requests[0]?.payload).toMatchObject({ content: 'Pong!', ephemeral: true });
    expect(ephemeralFlag(rest)).toBe(MESSAGE_FLAG_EPHEMERAL);
  });

  test('set public, it answers in the channel', async () => {
    const { ctx, rest } = harness({}, { replyPreference: false });

    await pingCommand.handler(ctx);

    expect(ephemeralFlag(rest)).toBe(0);
  });
});
