import { describe, expect, test } from 'bun:test';
import {
  type CaseInput,
  type CaseRecorder,
  type CommandContext,
  createCommandOptions,
  type DedupeStore,
  DefaultActionExecutor,
  type Logger,
  newId,
  Permissions,
  type PrecheckInput,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
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

function harness(config: Partial<PingConfig> = {}) {
  const rest = new FakeRest();
  const recorder = new MemoryRecorder();
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

  const ctx: CommandContext<PingConfig> = {
    guildId: GUILD,
    channelId: CHANNEL,
    userId: USER,
    config: { ...pingDefaultConfig, ...config },
    executor,
    logger,
    options: createCommandOptions([]),
    interaction: { id: INTERACTION, token: LIVE_TOKEN },
    idempotencyKey: newId(),
  };

  return { ctx, rest, recorder, lines };
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
