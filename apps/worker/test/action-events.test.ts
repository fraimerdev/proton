import { describe, expect, test } from 'bun:test';
import type { CaseInput, CaseRecorder, EventBus, Logger, ProtonEvent } from '@proton/core';
import { protonActionExecutedSchema } from '@proton/core';
import { PublishingCaseRecorder, publishableCase } from '../src/action-events.ts';

const GUILD = '900000000000000001';

class MemoryRecorder implements CaseRecorder {
  readonly recorded: CaseInput[] = [];
  caseId = 'case-1';

  async record(input: CaseInput): Promise<{ caseId: string }> {
    this.recorded.push(input);
    return { caseId: this.caseId };
  }
}

class MemoryBus {
  readonly published: ProtonEvent[] = [];
  throws = false;

  async publish(event: ProtonEvent): Promise<void> {
    if (this.throws) throw new Error('redis is down');
    this.published.push(event);
  }

  subscribe() {
    return { group: '', close: async () => {} };
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function collecting(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, logger: { info: () => {}, warn: () => {}, error: (m) => lines.push(m) } };
}

function caseInput(overrides: Partial<CaseInput> = {}): CaseInput {
  return {
    guildId: GUILD,
    moduleId: 'moderation',
    kind: 'ban',
    actorId: '200000000000000009',
    targetId: '100000000000000007',
    reason: 'raiding',
    dryRun: false,
    idempotencyKey: 'k1',
    ...overrides,
  };
}

function build(logger: Logger = silent) {
  const inner = new MemoryRecorder();
  const bus = new MemoryBus();

  const recorder = new PublishingCaseRecorder({
    inner,
    bus: bus as unknown as EventBus,
    logger,
    publishFor: publishableCase,
    now: () => 1_700_000_000_000,
  });

  return { inner, bus, recorder };
}

describe('PublishingCaseRecorder', () => {
  test('still records the case, and returns the id the executor needs', async () => {
    const { inner, recorder } = build();

    expect(await recorder.record(caseInput())).toEqual({ caseId: 'case-1' });
    expect(inner.recorded).toHaveLength(1);
  });

  test('publishes an event carrying everything a log needs', async () => {
    const { bus, recorder } = build();

    await recorder.record(caseInput());

    expect(bus.published).toHaveLength(1);
    const parsed = protonActionExecutedSchema.safeParse(bus.published[0]?.payload);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.caseId).toBe('case-1');
    expect(parsed.data?.kind).toBe('ban');
    expect(parsed.data?.reason).toBe('raiding');
  });

  test('the event id is the case id, so a redelivery cannot double-log', async () => {
    const { bus, recorder } = build();

    await recorder.record(caseInput());

    expect(bus.published[0]?.id).toBe(`proton.action_executed:${GUILD}:case-1`);
  });

  test('serverlog’s own sends are never published, or the log would log itself', async () => {
    const { bus, recorder } = build();

    await recorder.record(caseInput({ moduleId: 'serverlog', kind: 'send' }));

    expect(bus.published).toEqual([]);
  });

  test('a dry run is recorded but not announced as though it happened', async () => {
    const { inner, bus, recorder } = build();

    await recorder.record(caseInput({ dryRun: true }));

    expect(inner.recorded).toHaveLength(1);
    expect(bus.published).toEqual([]);
  });

  test('a failed publish never fails the action that already happened', async () => {
    const { logger, lines } = collecting();
    const { inner, bus, recorder } = build(logger);
    bus.throws = true;

    expect(await recorder.record(caseInput())).toEqual({ caseId: 'case-1' });
    expect(inner.recorded).toHaveLength(1);
    expect(lines.join(' ')).toContain('could not be published');
  });

  test('a reversal is marked as one, so a listener can tell a lifted ban from a new unban', async () => {
    const { bus, recorder } = build();

    await recorder.record(
      caseInput({ kind: 'unban', actorId: 'proton:auto-reversal', idempotencyKey: 'reversal:k1' }),
    );

    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload).reversal).toBe(true);
  });

  test('an ordinary action carries no reversal flag', async () => {
    const { bus, recorder } = build();

    await recorder.record(caseInput({ idempotencyKey: 'moderation:report:Xk3P9aQ:accept:action' }));

    expect(bus.published[0]?.payload).not.toHaveProperty('reversal');
    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload).reversal).toBeUndefined();
  });

  test('a key merely mentioning a reversal is not one', async () => {
    const { bus, recorder } = build();

    await recorder.record(caseInput({ idempotencyKey: 'moderation:reversal:k1' }));

    expect(bus.published[0]?.payload).not.toHaveProperty('reversal');
  });

  test('an expiry is carried as a timestamp the renderer can format', async () => {
    const { bus, recorder } = build();
    const expiresAt = new Date('2026-08-17T00:00:00.000Z');

    await recorder.record(caseInput({ kind: 'timeout', expiresAt }));

    const parsed = protonActionExecutedSchema.parse(bus.published[0]?.payload);
    expect(parsed.expiresAt).toBe(expiresAt.getTime());
  });

  test('a timeout carries when it ends, read from the payload Discord was sent', async () => {
    const { bus, recorder } = build();
    const until = new Date('2026-09-19T12:30:00.000Z');

    await recorder.record(
      caseInput({ kind: 'timeout', payload: { userId: '100000000000000007', until } }),
    );

    const parsed = protonActionExecutedSchema.parse(bus.published[0]?.payload);
    expect(parsed.until).toBe(until.getTime());
    expect(parsed.expiresAt).toBeNull();
  });

  test('a timeout Proton renews past 28 days carries the end it renews to', async () => {
    const { bus, recorder } = build();
    const until = new Date('2026-10-17T12:25:00.000Z');
    const endsAt = new Date('2026-11-18T12:30:00.000Z');

    await recorder.record(
      caseInput({ kind: 'timeout', payload: { userId: '100000000000000007', until, endsAt } }),
    );

    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload).until).toBe(
      endsAt.getTime(),
    );
  });

  test('a timeout an earlier, longer one outlasts carries the end Discord holds', async () => {
    const { bus, recorder } = build();
    const until = new Date('2026-09-20T12:30:00.000Z');
    const endsAt = new Date('2026-09-19T13:30:00.000Z');

    await recorder.record(
      caseInput({ kind: 'timeout', payload: { userId: '100000000000000007', until, endsAt } }),
    );

    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload).until).toBe(until.getTime());
  });

  test('a timeout whose payload has no readable end says so rather than guessing', async () => {
    const { bus, recorder } = build();

    await recorder.record(
      caseInput({ kind: 'timeout', payload: { userId: '100000000000000007' } }),
    );

    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload).until).toBeNull();
  });

  test('only a timeout carries an end', async () => {
    const { bus, recorder } = build();

    await recorder.record(
      caseInput({
        kind: 'untimeout',
        payload: { userId: '100000000000000007', until: new Date('2026-09-19T12:30:00.000Z') },
      }),
    );

    expect(bus.published[0]?.payload).not.toHaveProperty('until');
  });

  const CHANNEL = '500000000000000001';
  const ROLE = '900000000000000001';

  test('a slowmode carries its channel and the new wait', async () => {
    const { bus, recorder } = build();

    await recorder.record(
      caseInput({
        kind: 'slowmode',
        targetId: undefined,
        payload: { channelId: CHANNEL, seconds: 30 },
      }),
    );

    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload)).toMatchObject({
      channelId: CHANNEL,
      seconds: 30,
    });
  });

  test.each([
    ['purge', { channelId: CHANNEL, messageIds: ['600000000000000001', '600000000000000002'] }],
    ['lockdown', { channelId: CHANNEL, roleId: ROLE }],
    ['unlock', { channelId: CHANNEL, roleId: ROLE }],
  ] as const)('a %s carries the channel it touched', async (kind, payload) => {
    const { bus, recorder } = build();

    await recorder.record(caseInput({ kind, targetId: undefined, payload }));

    const parsed = protonActionExecutedSchema.parse(bus.published[0]?.payload);
    expect(parsed.channelId).toBe(CHANNEL);
    expect(parsed.seconds).toBeUndefined();
  });

  test('a channel action whose payload has no readable channel says so', async () => {
    const { bus, recorder } = build();

    await recorder.record(caseInput({ kind: 'lockdown', targetId: undefined, payload: {} }));

    expect(protonActionExecutedSchema.parse(bus.published[0]?.payload).channelId).toBeNull();
  });

  test('a member action carries no channel', async () => {
    const { bus, recorder } = build();

    await recorder.record(
      caseInput({ payload: { userId: '100000000000000007', channelId: CHANNEL } }),
    );

    expect(bus.published[0]?.payload).not.toHaveProperty('channelId');
  });
});

describe('publishableCase', () => {
  test('accepts a real moderation action', () => {
    expect(publishableCase(caseInput())).toBe(true);
  });

  test('rejects serverlog and dry runs', () => {
    expect(publishableCase(caseInput({ moduleId: 'serverlog' }))).toBe(false);
    expect(publishableCase(caseInput({ dryRun: true }))).toBe(false);
  });
});
