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

  test('an expiry is carried as a timestamp the renderer can format', async () => {
    const { bus, recorder } = build();
    const expiresAt = new Date('2026-08-17T00:00:00.000Z');

    await recorder.record(caseInput({ kind: 'timeout', expiresAt }));

    const parsed = protonActionExecutedSchema.parse(bus.published[0]?.payload);
    expect(parsed.expiresAt).toBe(expiresAt.getTime());
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
