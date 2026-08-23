import { describe, expect, test } from 'bun:test';
import type { CaseInput, CaseRecorder } from '../../src/actions/case-recorder.ts';
import type { DedupeStore } from '../../src/actions/dedupe.ts';
import { DefaultActionExecutor, REDACTED, redactSecrets } from '../../src/actions/executor.ts';
import type { PrecheckInput } from '../../src/actions/prechecks.ts';
import type {
  RestProxyClient,
  RestRequestOptions,
  RestResponse,
} from '../../src/actions/rest-client.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import { newId } from '../../src/ids.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const BOT = '300000000000000000';
const CHANNEL = '500000000000000000';
const INTERACTION = '600000000000000000';
const LIVE_TOKEN = 'aW50ZXJhY3Rpb24tdG9rZW4.live.15-minutes';

class MemoryDedupe implements DedupeStore {
  readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.claimed.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.claimed.has(key);
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
  response: RestResponse = { status: 200, body: { id: '1' } };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

function build() {
  const recorder = new MemoryRecorder();
  const rest = new FakeRest();

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder,
    resolveContext: async (): Promise<PrecheckInput> => ({
      guildId: GUILD,
      guildOwnerId: '200000000000000000',
      botUserId: BOT,
      botHighestRolePosition: 10,
      botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
      requiredPermissions: 0n,
      channelId: CHANNEL,
    }),
  });

  return { executor, recorder, rest };
}

function replyRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'ping',
    kind: 'interaction_reply',
    actorId: '100000000000000000',
    dryRun: false,
    idempotencyKey: newId(),
    payload: {
      interactionId: INTERACTION,
      interactionToken: LIVE_TOKEN,
      content: 'Pong!',
      ephemeral: true,
    },
    ...overrides,
  };
}

describe('the case ledger holds moderation, not interaction plumbing', () => {
  test('an interaction reply reaches Discord but is never numbered as a case', async () => {
    const { executor, recorder, rest } = build();

    const result = await executor.execute(replyRequest());

    expect(result.status).toBe('executed');
    expect(rest.calls).toHaveLength(1);
    expect(recorder.recorded).toHaveLength(0);
    expect(result.caseId).toBeUndefined();
  });

  test('an interaction follow-up is not a case either', async () => {
    const { executor, recorder } = build();

    const result = await executor.execute(
      replyRequest({
        kind: 'interaction_followup',
        payload: {
          applicationId: '800000000000000000',
          interactionToken: LIVE_TOKEN,
          content: 'still working on it',
        },
      }),
    );

    expect(result.status).toBe('executed');
    expect(recorder.recorded).toHaveLength(0);
  });

  test('a call site cannot opt an acknowledgement back into the ledger with record: true', async () => {
    const { executor, recorder } = build();

    await executor.execute(replyRequest({ record: true }));

    expect(recorder.recorded).toHaveLength(0);
  });

  test('a dry-run acknowledgement is not a case either', async () => {
    const { executor, recorder } = build();

    const result = await executor.execute(replyRequest({ dryRun: true }));

    expect(result.status).toBe('dry_run');
    expect(result.caseId).toBeUndefined();
    expect(recorder.recorded).toHaveLength(0);
  });

  test('a real moderation action is still recorded', async () => {
    const { executor, recorder } = build();

    const result = await executor.execute(
      replyRequest({
        kind: 'kick',
        moduleId: 'moderation',
        targetId: '400000000000000000',
        payload: { userId: '400000000000000000' },
      }),
    );

    expect(result.status).toBe('executed');
    expect(recorder.recorded).toHaveLength(1);
    expect(recorder.recorded[0]?.kind).toBe('kick');
  });
});

describe('no credential reaches the case ledger', () => {
  test('a recorded payload carries no token, whatever the kind smuggled one in', async () => {
    const { executor, recorder } = build();

    await executor.execute(
      replyRequest({
        kind: 'send',
        payload: {
          channelId: CHANNEL,
          content: 'Pong!',
          interactionToken: LIVE_TOKEN,
        },
      }),
    );

    const payload = recorder.recorded[0]?.payload as Record<string, unknown>;

    expect(payload.interactionToken).toBe(REDACTED);
    expect(JSON.stringify(recorder.recorded)).not.toContain(LIVE_TOKEN);
  });

  test('redacts a credential key however deeply it is nested', () => {
    const redacted = redactSecrets({
      content: 'hello',
      nested: { token: LIVE_TOKEN, keep: 1 },
      list: [{ authorization: 'Bearer x' }, { webhookSecret: 's' }],
    }) as Record<string, unknown>;

    expect(JSON.stringify(redacted)).not.toContain(LIVE_TOKEN);
    expect(redacted.content).toBe('hello');
    expect((redacted.nested as Record<string, unknown>).keep).toBe(1);
    expect(JSON.stringify(redacted.list)).toBe(
      JSON.stringify([{ authorization: REDACTED }, { webhookSecret: REDACTED }]),
    );
  });

  test('matches a credential key whatever its casing', () => {
    const redacted = redactSecrets({
      interactionToken: 'a',
      Token: 'b',
      BOT_TOKEN: 'c',
      password: 'd',
    }) as Record<string, unknown>;

    expect(Object.values(redacted)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  test('leaves an attachment intact instead of exploding its bytes into index keys', () => {
    const data = new Uint8Array([1, 2, 3]);

    const redacted = redactSecrets({ files: [{ filename: 'card.png', data }] }) as {
      files: Array<{ filename: string; data: Uint8Array }>;
    };

    expect(redacted.files[0]?.data).toBe(data);
    expect(redacted.files[0]?.filename).toBe('card.png');
  });

  test('passes non-object payloads through untouched', () => {
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets('a string')).toBe('a string');
    expect(redactSecrets(7)).toBe(7);
  });
});
