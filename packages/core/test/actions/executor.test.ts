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
import type { ActionFailure, ActionRequest } from '../../src/actions/types.ts';
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
  failure: Error | undefined;

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    if (this.failure) throw this.failure;
    return this.response;
  }
}

const CONTEXT: PrecheckInput = {
  guildId: GUILD,
  guildOwnerId: '200000000000000000',
  botUserId: BOT,
  botHighestRolePosition: 10,
  botChannelPermissions: Permissions.ViewChannel | Permissions.SendMessages,
  requiredPermissions: 0n,
  channelId: CHANNEL,
};

function build() {
  const recorder = new MemoryRecorder();
  const rest = new FakeRest();
  const lookups = { count: 0, targetGone: false };

  const executor = new DefaultActionExecutor({
    dedupe: new MemoryDedupe(),
    rest,
    recorder,
    resolveContext: async (): Promise<PrecheckInput | { failure: ActionFailure }> => {
      lookups.count += 1;
      if (!lookups.targetGone) return CONTEXT;

      return {
        failure: {
          code: 'target_state_unavailable',
          humanReason: "I couldn't look up that member's roles.",
        },
      };
    },
  });

  return { executor, recorder, rest, lookups };
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

describe('a redelivered action is answered from the idempotency key', () => {
  const TARGET = '400000000000000000';

  function kick(): ActionRequest {
    return replyRequest({
      kind: 'kick',
      moduleId: 'phishing',
      targetId: TARGET,
      payload: { userId: TARGET },
    });
  }

  test('a kick that went through is a duplicate on redelivery, not a failed lookup of the member it removed', async () => {
    const { executor, recorder, rest, lookups } = build();
    const request = kick();

    expect((await executor.execute(request)).status).toBe('executed');
    lookups.targetGone = true;

    const again = await executor.execute(request);

    expect(again).toEqual({ status: 'skipped_duplicate' });
    expect(rest.calls).toHaveLength(1);
    expect(lookups.count).toBe(1);
    expect(recorder.recorded).toHaveLength(1);
  });

  test('a send that went through makes no second REST call and resolves no context', async () => {
    const { executor, rest, lookups } = build();
    const request = replyRequest({
      kind: 'send',
      payload: { channelId: CHANNEL, content: 'Phishing link detected.' },
    });

    await executor.execute(request);
    const again = await executor.execute(request);

    expect(again.status).toBe('skipped_duplicate');
    expect(rest.calls).toHaveLength(1);
    expect(lookups.count).toBe(1);
  });

  test('a kick Discord refused released its key, so the redelivery prechecks and runs again', async () => {
    const { executor, recorder, rest, lookups } = build();
    const request = kick();
    rest.response = { status: 403, body: { message: 'Missing Permissions' } };

    expect((await executor.execute(request)).status).toBe('failed_api');

    rest.response = { status: 204, body: undefined };
    const retry = await executor.execute(request);

    expect(retry.status).toBe('executed');
    expect(rest.calls).toHaveLength(2);
    expect(lookups.count).toBe(2);
    expect(recorder.recorded).toHaveLength(1);
  });

  test('a kick that never reached Discord is retried in full, lookup included', async () => {
    const { executor, rest, lookups } = build();
    const request = kick();
    rest.failure = new Error('connect ECONNREFUSED');

    expect((await executor.execute(request)).failure?.code).toBe('transport_failure');

    rest.failure = undefined;
    lookups.targetGone = true;
    const retry = await executor.execute(request);

    expect(retry.status).toBe('failed_precheck');
    expect(retry.failure?.code).toBe('target_state_unavailable');
    expect(lookups.count).toBe(2);
  });
});

describe('a failure Discord explains', () => {
  function dm(): ActionRequest {
    return replyRequest({
      kind: 'send',
      moduleId: 'moderation',
      payload: { channelId: CHANNEL, content: 'You were banned.' },
      record: false,
    });
  }

  test('carries Discord’s own error code, so a closed DM is told apart from a missing permission', async () => {
    const { executor, rest } = build();
    rest.response = {
      status: 403,
      body: { code: 50007, message: 'Cannot send messages to this user' },
    };

    const result = await executor.execute(dm());

    expect(result.status).toBe('failed_api');
    expect(result.failure?.code).toBe('discord_403');
    expect(result.failure?.discordCode).toBe(50007);
  });

  test('has no code when Discord sent none', async () => {
    const { executor, rest } = build();
    rest.response = { status: 502, body: 'Bad Gateway' };

    const result = await executor.execute(dm());

    expect(result.failure?.code).toBe('discord_502');
    expect(result.failure).not.toHaveProperty('discordCode');
  });

  test('ignores a code that is not a number', async () => {
    const { executor, rest } = build();
    rest.response = { status: 400, body: { code: '50278', message: 'x' } };

    expect((await executor.execute(dm())).failure).not.toHaveProperty('discordCode');
  });

  test('a precheck refusal never carries one', async () => {
    const { executor, lookups } = build();
    lookups.targetGone = true;

    const result = await executor.execute(
      replyRequest({
        kind: 'kick',
        targetId: '400000000000000000',
        payload: { userId: '400000000000000000' },
      }),
    );

    expect(result.status).toBe('failed_precheck');
    expect(result.failure).not.toHaveProperty('discordCode');
  });
});

describe('an audit reason', () => {
  const TARGET = '400000000000000000';

  test('reaches Discord’s audit log while the case keeps the moderator’s reason', async () => {
    const { executor, recorder, rest } = build();

    await executor.execute(
      replyRequest({
        kind: 'ban',
        moduleId: 'moderation',
        targetId: TARGET,
        payload: { userId: TARGET },
        reason: 'spamming',
        auditReason: 'Nova: spamming',
      }),
    );

    expect(rest.calls[0]?.headers?.['x-audit-log-reason']).toBe(
      encodeURIComponent('Nova: spamming'),
    );
    expect(recorder.recorded[0]?.reason).toBe('spamming');
    expect(JSON.stringify(recorder.recorded[0])).not.toContain('Nova');
  });

  test('longer than Discord’s 512 is refused before anything happens', async () => {
    const { executor, recorder, rest } = build();

    const result = await executor.execute(
      replyRequest({
        kind: 'ban',
        targetId: TARGET,
        payload: { userId: TARGET },
        auditReason: 'x'.repeat(513),
      }),
    );

    expect(result.failure?.code).toBe('invalid_request');
    expect(rest.calls).toHaveLength(0);
    expect(recorder.recorded).toHaveLength(0);
  });

  test('of exactly 512 is accepted', async () => {
    const { executor } = build();

    const result = await executor.execute(
      replyRequest({
        kind: 'ban',
        targetId: TARGET,
        payload: { userId: TARGET },
        auditReason: 'x'.repeat(512),
      }),
    );

    expect(result.status).toBe('executed');
  });
});

describe('a precheck', () => {
  const TARGET = '400000000000000000';

  function ban(overrides: Partial<ActionRequest> = {}): ActionRequest {
    return replyRequest({
      kind: 'ban',
      moduleId: 'moderation',
      targetId: TARGET,
      payload: { userId: TARGET },
      ...overrides,
    });
  }

  test('passes what execute would carry out, and changes nothing', async () => {
    const { executor, recorder, rest } = build();
    const request = ban();

    expect(await executor.precheck(request)).toBeNull();
    expect(rest.calls).toHaveLength(0);
    expect(recorder.recorded).toHaveLength(0);
  });

  test('claims no idempotency key, so the real action still runs afterwards', async () => {
    const { executor, rest } = build();
    const request = ban();

    await executor.precheck(request);
    await executor.precheck(request);
    const result = await executor.execute(request);

    expect(result.status).toBe('executed');
    expect(rest.calls).toHaveLength(1);
  });

  test('refuses with the same failure execute would give', async () => {
    const { executor, lookups, rest, recorder } = build();
    lookups.targetGone = true;

    const refused = await executor.precheck(ban());
    const executed = await executor.execute(ban());

    expect(refused?.code).toBe('target_state_unavailable');
    expect(executed.failure).toEqual(refused ?? undefined);
    expect(rest.calls).toHaveLength(0);
    expect(recorder.recorded).toHaveLength(0);
  });

  test('refuses an invalid payload before looking anything up', async () => {
    const { executor, lookups } = build();

    const refused = await executor.precheck(ban({ payload: { userId: 'nobody' } }));

    expect(refused?.code).toBe('invalid_payload');
    expect(lookups.count).toBe(0);
  });

  test('refuses a request the schema rejects', async () => {
    const { executor } = build();

    expect((await executor.precheck(ban({ reason: 'x'.repeat(513) })))?.code).toBe(
      'invalid_request',
    );
  });

  test('has nothing to refuse once the action already went through', async () => {
    const { executor, lookups } = build();
    const request = ban();

    await executor.execute(request);
    lookups.targetGone = true;

    expect(await executor.precheck(request)).toBeNull();
    expect(lookups.count).toBe(1);
  });

  test('survives scoping, which is how every module receives the executor', async () => {
    const { executor, lookups } = build();
    lookups.targetGone = true;

    const scoped = executor.scoped({ channelId: CHANNEL });

    expect((await scoped.precheck?.(ban()))?.code).toBe('target_state_unavailable');
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
