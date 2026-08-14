import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { CaseInput, CaseRecorder } from '../../src/actions/case-recorder.ts';
import { RedisDedupeStore } from '../../src/actions/dedupe.ts';
import { DefaultActionExecutor } from '../../src/actions/executor.ts';
import type { PrecheckInput } from '../../src/actions/prechecks.ts';
import type { RestProxyClient, RestResponse } from '../../src/actions/rest-client.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import { newId } from '../../src/ids.ts';
import { Permissions } from '../../src/permissions/bits.ts';

let container: StartedRedisContainer;
let redis: Redis;

const GUILD = '900000000000000001';
const BOT = '300000000000000000';
const CHANNEL = '500000000000000000';

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await redis.flushall();
});

class InMemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];
  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: newId() };
  }
}

class FakeRest implements RestProxyClient {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  response: RestResponse = { status: 200, body: { id: '1' } };
  failure: Error | undefined;

  async request(options: { method: string; path: string; body?: unknown }): Promise<RestResponse> {
    this.calls.push(options);
    if (this.failure) throw this.failure;
    return this.response;
  }
}

function build(overrides: Partial<PrecheckInput> = {}) {
  const recorder = new InMemoryRecorder();
  const rest = new FakeRest();
  const executor = new DefaultActionExecutor({
    dedupe: new RedisDedupeStore(redis),
    rest,
    recorder,
    resolveContext: async (): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: '200000000000000000',
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
      requiredPermissions: Permissions.SendMessages,
      channelId: CHANNEL,
      ...overrides,
    }),
  });

  return { executor, recorder, rest };
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'ping',
    kind: 'send',
    actorId: '100000000000000000',
    payload: { channelId: CHANNEL, content: 'Pong!' },
    dryRun: false,
    idempotencyKey: newId(),
    ...overrides,
  };
}

describe('DefaultActionExecutor', () => {
  test('executes a valid action and records exactly one case', async () => {
    const { executor, recorder, rest } = build();

    const result = await executor.execute(request());

    expect(result.status).toBe('executed');
    expect(result.caseId).toBeDefined();
    expect(rest.calls).toHaveLength(1);
    expect(recorder.recorded).toHaveLength(1);
  });

  test('the same idempotency key twice produces one case, not two', async () => {
    const { executor, recorder, rest } = build();
    const req = request();

    const first = await executor.execute(req);
    const second = await executor.execute(req);

    expect(first.status).toBe('executed');
    expect(second.status).toBe('skipped_duplicate');
    // I4 in one assertion: the redelivered event caused no second side effect.
    expect(rest.calls).toHaveLength(1);
    expect(recorder.recorded).toHaveLength(1);
  });

  test('dry run records a case and issues no REST call at all', async () => {
    const { executor, recorder, rest } = build();

    const result = await executor.execute(request({ dryRun: true }));

    expect(result.status).toBe('dry_run');
    // I12: in development a destructive action must be observable without
    // actually happening, so the case exists but Discord was never touched.
    expect(rest.calls).toHaveLength(0);
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.dryRun).toBe(true);
  });

  test('a precheck failure returns a structured reason and records nothing', async () => {
    const { executor, recorder, rest } = build({ botChannelPermissions: Permissions.ViewChannel });

    const result = await executor.execute(request());

    expect(result.status).toBe('failed_precheck');
    expect(result.failure?.code).toBe('missing_permission');
    expect(result.failure?.humanReason).toContain('SendMessages');
    expect(rest.calls).toHaveLength(0);
    expect(recorder.recorded).toHaveLength(0);
  });

  /**
   * A precheck failure must not burn the idempotency key. If it did, fixing the
   * permission and retrying the same logical action would be silently discarded
   * as a duplicate and nothing would ever happen.
   */
  test('a precheck failure leaves the idempotency key reusable', async () => {
    const failing = build({ botChannelPermissions: Permissions.ViewChannel });
    const req = request();

    expect((await failing.executor.execute(req)).status).toBe('failed_precheck');

    const working = build();
    const retry = await working.executor.execute(req);

    expect(retry.status).toBe('executed');
  });

  test('an upstream error surfaces the Discord status and frees the key for retry', async () => {
    const { executor, rest, recorder } = build();
    rest.response = { status: 403, body: { message: 'Missing Permissions' } };
    const req = request();

    const failed = await executor.execute(req);

    expect(failed.status).toBe('failed_api');
    expect(failed.failure?.code).toBe('discord_403');
    expect(failed.failure?.humanReason).toContain('Missing Permissions');
    expect(recorder.recorded).toHaveLength(0);

    // The same request can now be retried once the cause is fixed.
    rest.response = { status: 200, body: {} };
    expect((await executor.execute(req)).status).toBe('executed');
  });

  test('a transport failure is reported as failed_api, not thrown', async () => {
    const { executor, rest } = build();
    rest.failure = new Error('connection refused');

    const result = await executor.execute(request());

    expect(result.status).toBe('failed_api');
    expect(result.failure?.code).toBe('transport_failure');
    expect(result.failure?.humanReason).toContain('connection refused');
  });

  test('rejects an expiry it cannot honour rather than silently dropping it', async () => {
    const { executor } = build();

    const result = await executor.execute(request({ expiresAt: new Date(Date.now() + 60_000) }));

    expect(result.status).toBe('failed_precheck');
    expect(result.failure?.code).toBe('unsupported_expiry');
  });

  test('rejects a malformed payload before touching Discord', async () => {
    const { executor, rest } = build();

    const result = await executor.execute(request({ payload: { channelId: CHANNEL } }));

    expect(result.status).toBe('failed_precheck');
    expect(result.failure?.code).toBe('invalid_payload');
    expect(rest.calls).toHaveLength(0);
  });
});
