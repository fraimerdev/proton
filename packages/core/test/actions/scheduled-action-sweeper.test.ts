import { beforeEach, describe, expect, test } from 'bun:test';
import type { CaseReversalInput, CaseReversalStore } from '../../src/actions/reversal.ts';
import {
  ScheduledActionSweeper,
  type ScheduledModuleJob,
} from '../../src/actions/scheduled-action-sweeper.ts';
import type {
  ClaimDueOptions,
  CompleteOutcome,
  ScheduledActionInput,
  ScheduledActionRecord,
  ScheduledActionStore,
  ScheduleOutcome,
} from '../../src/actions/scheduled-actions.ts';
import type { ActionExecutor, ActionRequest, ActionResult } from '../../src/actions/types.ts';
import type { Logger } from '../../src/modules/manifest.ts';

const GUILD = '900000000000000001';
const NOW = new Date('2026-08-17T12:00:00.000Z');
const LOCK_MS = 30_000;
const JOB_KEY = `reminders:remind:${GUILD}:natural`;

let clock: Date;

type Row = Omit<ScheduledActionRecord, 'lockToken'> & {
  lockedUntil: Date | null;
  lockToken: string | null;
};

const holdsLock = (row: Row, lockToken: string): boolean => row.lockToken === lockToken;

class MemoryStore implements ScheduledActionStore, CaseReversalStore {
  readonly rows: Row[] = [];
  readonly reverted: CaseReversalInput[] = [];

  onRenew: ((held: boolean) => void) | undefined;
  renewError: Error | undefined;
  completeThrowsFor: string | undefined;

  // ids and tokens are never recycled: a reused one would let a superseded sweep retire the row
  // that replaced the one it actually ran
  #nextId = 1;
  #nextToken = 1;

  #insert(input: Omit<ScheduledActionInput, 'onConflict'>): Row {
    const row: Row = {
      id: `row-${this.#nextId++}`,
      guildId: input.guildId,
      runAt: input.runAt,
      kind: input.kind,
      attempts: 0,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      lockedUntil: null,
      lockToken: null,
    };

    this.rows.push(row);
    return row;
  }

  async schedule(input: ScheduledActionInput): Promise<ScheduleOutcome> {
    const existing = this.rows.find((row) => row.idempotencyKey === input.idempotencyKey);

    if (existing) {
      if (input.onConflict !== 'replace') return { scheduled: false, replaced: false };

      existing.runAt = input.runAt;
      existing.kind = input.kind;
      existing.payload = input.payload;
      existing.attempts = 0;
      existing.lockedUntil = null;
      existing.lockToken = null;
      return { scheduled: true, replaced: true };
    }

    this.#insert(input);
    return { scheduled: true, replaced: false };
  }

  async claimDue(options: ClaimDueOptions): Promise<ScheduledActionRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.runAt <= options.now &&
          (row.lockedUntil === null || row.lockedUntil < options.now) &&
          row.attempts < options.maxAttempts,
      )
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, options.limit)
      .map((row) => {
        row.attempts += 1;
        row.lockedUntil = options.lockUntil;
        row.lockToken = `token-${this.#nextToken++}`;
        return { ...row, lockToken: row.lockToken };
      });
  }

  async renew(scheduledActionId: string, lockToken: string, lockUntil: Date): Promise<boolean> {
    if (this.renewError) {
      this.onRenew?.(false);
      throw this.renewError;
    }

    const row = this.rows.find((r) => r.id === scheduledActionId && holdsLock(r, lockToken));
    if (row) row.lockedUntil = lockUntil;

    this.onRenew?.(row !== undefined);
    return row !== undefined;
  }

  async complete(scheduledActionId: string, lockToken: string): Promise<CompleteOutcome> {
    if (this.completeThrowsFor === scheduledActionId) {
      throw new Error('the connection to the database was reset');
    }

    const index = this.rows.findIndex(
      (row) => row.id === scheduledActionId && holdsLock(row, lockToken),
    );
    if (index < 0) return 'lost';

    this.rows.splice(index, 1);
    return 'retired';
  }

  async completeAndSchedule(
    scheduledActionId: string,
    lockToken: string,
    next: Omit<ScheduledActionInput, 'onConflict'>,
  ): Promise<CompleteOutcome> {
    if ((await this.complete(scheduledActionId, lockToken)) === 'lost') return 'lost';

    this.#insert(next);
    return 'retired';
  }

  async cancel(idempotencyKey: string): Promise<{ cancelled: boolean }> {
    const index = this.rows.findIndex((row) => row.idempotencyKey === idempotencyKey);
    if (index < 0) return { cancelled: false };
    this.rows.splice(index, 1);
    return { cancelled: true };
  }

  async release(scheduledActionId: string, lockToken: string): Promise<void> {
    const row = this.rows.find((r) => r.id === scheduledActionId && holdsLock(r, lockToken));
    if (!row) return;

    row.lockedUntil = null;
    row.lockToken = null;
  }

  async markReverted(input: CaseReversalInput): Promise<void> {
    this.reverted.push(input);
  }
}

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  result: ActionResult = { status: 'executed' };
  hold: Promise<void> | undefined;
  onExecute: (() => void) | undefined;

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    this.onExecute?.();
    if (this.hold) await this.hold;
    return this.result;
  }
}

class CollectingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string }> = [];
  info(message: string) {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string) {
    this.lines.push({ level: 'warn', message });
  }
  error(message: string) {
    this.lines.push({ level: 'error', message });
  }
  matching(level: string, fragment: string) {
    return this.lines.filter((l) => l.level === level && l.message.includes(fragment));
  }
}

let store: MemoryStore;
let executor: RecordingExecutor;
let logger: CollectingLogger;
let ran: ScheduledModuleJob[];

beforeEach(() => {
  store = new MemoryStore();
  executor = new RecordingExecutor();
  logger = new CollectingLogger();
  ran = [];
  clock = new Date(NOW);
});

function sweeper(
  options: {
    runModuleJob?: (job: ScheduledModuleJob) => Promise<void>;
    maxAttempts?: number;
    renewMs?: number;
  } = {},
) {
  return new ScheduledActionSweeper({
    store,
    cases: store,
    executor,
    logger,
    now: () => clock,
    lockMs: LOCK_MS,
    ...(options.runModuleJob ? { runModuleJob: options.runModuleJob } : {}),
    ...(options.renewMs === undefined ? {} : { renewMs: options.renewMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
}

const NOTHING = { claimed: 0, reverted: 0, ran: 0, retrying: 0, abandoned: 0, aborted: 0 };

const collect = async (job: ScheduledModuleJob): Promise<void> => {
  ran.push(job);
};

function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

const NEVER = 10 * 60_000;

async function scheduleModuleJob(
  overrides: { jobId?: string; naturalKey?: string; data?: unknown; runAt?: Date } = {},
) {
  const jobId = overrides.jobId ?? 'remind';
  const naturalKey = overrides.naturalKey ?? 'natural';

  await store.schedule({
    guildId: GUILD,
    runAt: overrides.runAt ?? new Date(clock.getTime() - 1000),
    kind: 'module_job',
    idempotencyKey: `reminders:${jobId}:${GUILD}:${naturalKey}`,
    payload: {
      kind: 'module',
      moduleId: 'reminders',
      jobId,
      guildId: GUILD,
      data: overrides.data ?? { text: 'stand up' },
    },
  });
}

async function scheduleReversal() {
  await store.schedule({
    guildId: GUILD,
    runAt: new Date(clock.getTime() - 1000),
    kind: 'unban',
    idempotencyKey: 'reversal:abc',
    payload: {
      kind: 'reversal',
      caseId: 'case-1',
      moduleId: 'moderation',
      actorId: '100000000000000000',
      targetId: '400000000000000000',
      originalKind: 'ban',
      action: { userId: '400000000000000000' },
    },
  });
}

describe('ScheduledActionSweeper module arm', () => {
  test('hands a module payload to the job runner and retires the row', async () => {
    await scheduleModuleJob();

    expect(await sweeper({ runModuleJob: collect }).sweep()).toEqual({
      ...NOTHING,
      claimed: 1,
      ran: 1,
    });

    expect(ran).toHaveLength(1);
    expect(ran[0]?.moduleId).toBe('reminders');
    expect(ran[0]?.jobId).toBe('remind');
    expect(ran[0]?.guildId).toBe(GUILD);
    expect(ran[0]?.data).toEqual({ text: 'stand up' });
    expect(ran[0]?.idempotencyKey).toBe(JOB_KEY);

    expect(store.rows).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
  });

  test('a module job that throws leaves the row unlocked for the next sweep', async () => {
    await scheduleModuleJob();
    const failing = sweeper({
      runModuleJob: async () => {
        throw new Error('the reminder channel is gone');
      },
    });

    expect((await failing.sweep()).retrying).toBe(1);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.attempts).toBe(1);
    expect(store.rows[0]?.lockedUntil).toBeNull();
    expect(store.rows[0]?.lockToken).toBeNull();
    expect(logger.matching('warn', 'the reminder channel is gone')).toHaveLength(1);

    expect((await sweeper({ runModuleJob: collect }).sweep()).ran).toBe(1);
    expect(ran).toHaveLength(1);
  });

  test('a sweeper built without a job runner names the missing port and keeps the row', async () => {
    await scheduleModuleJob();

    expect((await sweeper().sweep()).retrying).toBe(1);

    const [warning] = logger.matching('warn', 'runModuleJob');
    expect(warning?.message).toContain('reminders:remind');
    expect(store.rows).toHaveLength(1);
  });

  test('a job that keeps throwing is abandoned rather than retried forever', async () => {
    await scheduleModuleJob();
    const failing = sweeper({
      maxAttempts: 2,
      runModuleJob: async () => {
        throw new Error('nope');
      },
    });

    expect((await failing.sweep()).retrying).toBe(1);
    expect((await failing.sweep()).abandoned).toBe(1);
    expect(await failing.sweep()).toEqual(NOTHING);

    expect(logger.matching('error', 'by hand')).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  test('an abandoned row is left unlocked, not fenced off behind a lock nobody holds', async () => {
    await scheduleModuleJob();
    const failing = sweeper({
      maxAttempts: 1,
      runModuleJob: async () => {
        throw new Error('nope');
      },
    });

    expect((await failing.sweep()).abandoned).toBe(1);

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.lockedUntil).toBeNull();
    expect(store.rows[0]?.lockToken).toBeNull();
  });
});

describe('ScheduledActionSweeper leases', () => {
  test('a handler still working three leases on keeps its row: the lease is renewed under it', async () => {
    await scheduleModuleJob();
    const handler = gate();
    const started = gate();

    let renewals = 0;
    const outlastedThreeLeases = new Promise<void>((resolve) => {
      // every renewal moves the clock half a lease on, so six of them outlast three whole leases
      store.onRenew = () => {
        clock = new Date(clock.getTime() + LOCK_MS / 2);
        renewals += 1;
        if (renewals === 6) resolve();
      };
    });

    const slow = sweeper({
      renewMs: 1,
      runModuleJob: async (job) => {
        ran.push(job);
        started.open();
        await handler.opened;
      },
    });

    const overrunning = slow.sweep();
    await started.opened;
    await Promise.race([outlastedThreeLeases, Bun.sleep(2000)]);

    expect(renewals).toBeGreaterThanOrEqual(6);
    expect(await sweeper({ runModuleJob: collect }).sweep()).toEqual(NOTHING);

    handler.open();
    expect(await overrunning).toEqual({ ...NOTHING, claimed: 1, ran: 1 });

    expect(ran).toHaveLength(1);
    expect(store.rows).toHaveLength(0);
    expect(logger.matching('error', 'lost the lease')).toHaveLength(0);
  });

  test('a run whose row is taken from it mid-handler stops instead of retiring a row it lost', async () => {
    await scheduleModuleJob();

    const lost = gate();
    store.onRenew = (held) => {
      if (!held) lost.open();
    };

    const losing = sweeper({
      renewMs: 1,
      runModuleJob: async (job) => {
        ran.push(job);
        await store.cancel(job.idempotencyKey);
        await Promise.race([lost.opened, Bun.sleep(2000)]);
      },
    });

    expect(await losing.sweep()).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });

    expect(logger.matching('error', 'lost the lease')).toHaveLength(1);
    expect(logger.matching('error', 'left the row untouched')).toHaveLength(1);
    expect(logger.matching('warn', 'will retry')).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  test('a renewal that keeps failing past the lease aborts instead of finishing on a lapsed lease', async () => {
    await scheduleModuleJob();
    store.renewError = new Error('the connection to the database was reset');

    const lapsed = gate();
    let attempts = 0;
    store.onRenew = () => {
      attempts += 1;
      // the first beat still sits inside the lease; the second finds it has run out
      if (attempts === 2) clock = new Date(clock.getTime() + LOCK_MS + 1);
      if (attempts >= 2) lapsed.open();
    };

    const blind = sweeper({
      renewMs: 1,
      runModuleJob: async (job) => {
        ran.push(job);
        await Promise.race([lapsed.opened, Bun.sleep(2000)]);
        await Bun.sleep(10);
      },
    });

    expect(await blind.sweep()).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });

    expect(logger.matching('warn', 'could not extend the lease')).toHaveLength(1);
    expect(logger.matching('error', 'lost the lease')).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.lockToken).not.toBeNull();
  });

  test('a sweep that lost the lock cannot retire, unlock or restart the row that now holds it', async () => {
    await scheduleModuleJob();
    const handler = gate();
    const started = gate();

    const overrunning = sweeper({
      renewMs: NEVER,
      runModuleJob: async (job) => {
        ran.push(job);
        started.open();
        await handler.opened;
      },
    }).sweep();

    await started.opened;
    clock = new Date(clock.getTime() + LOCK_MS + 1);

    expect((await sweeper({ runModuleJob: collect }).sweep()).ran).toBe(1);
    expect(store.rows).toHaveLength(0);

    handler.open();
    expect(await overrunning).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });

    expect(store.rows).toHaveLength(0);
    expect(logger.matching('error', 'left the row untouched')).toHaveLength(1);
    expect(logger.matching('warn', 'will retry')).toHaveLength(0);
  });

  test('a holder killed mid-handler leaves a row that runs exactly once afterwards', async () => {
    await scheduleModuleJob();

    // exactly what a killed sweep leaves behind: the row leased, no heartbeat, nothing retired
    await store.claimDue({
      now: clock,
      lockUntil: new Date(clock.getTime() + LOCK_MS),
      limit: 10,
      maxAttempts: 5,
    });

    expect(await sweeper({ runModuleJob: collect }).sweep()).toEqual(NOTHING);

    clock = new Date(clock.getTime() + LOCK_MS + 1);
    expect((await sweeper({ runModuleJob: collect }).sweep()).ran).toBe(1);

    expect(ran).toHaveLength(1);
    expect(store.rows).toHaveLength(0);

    clock = new Date(clock.getTime() + LOCK_MS * 5);
    expect(await sweeper({ runModuleJob: collect }).sweep()).toEqual(NOTHING);
    expect(ran).toHaveLength(1);
  });

  test('one row whose bookkeeping fails does not spend the attempts claimDue took for the rest', async () => {
    await scheduleModuleJob({ naturalKey: 'first', runAt: new Date(clock.getTime() - 3000) });
    await scheduleModuleJob({ naturalKey: 'second', runAt: new Date(clock.getTime() - 2000) });
    await scheduleModuleJob({ naturalKey: 'third', runAt: new Date(clock.getTime() - 1000) });

    store.completeThrowsFor = store.rows[0]?.id ?? '';

    expect(await sweeper({ runModuleJob: collect }).sweep()).toEqual({
      ...NOTHING,
      claimed: 3,
      ran: 2,
      aborted: 1,
    });

    expect(ran).toHaveLength(3);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.idempotencyKey).toBe(`reminders:remind:${GUILD}:first`);
    expect(store.rows[0]?.attempts).toBe(1);

    const [broken] = logger.matching('error', 'could not finish');
    expect(broken?.message).toContain('the connection to the database was reset');
  });
});

describe('ScheduledActionSweeper handlers that reschedule themselves', () => {
  test('the running row is retired and its successor inserted with a whole retry budget', async () => {
    await scheduleModuleJob();
    const [before] = store.rows;

    const renewing = sweeper({
      runModuleJob: async (job) => {
        ran.push(job);
        await job.reschedule({
          guildId: GUILD,
          runAt: new Date(clock.getTime() + 3600_000),
          kind: 'module_job',
          idempotencyKey: job.idempotencyKey,
          payload: {
            kind: 'module',
            moduleId: job.moduleId,
            jobId: job.jobId,
            guildId: GUILD,
            data: { text: 'next' },
          },
        });
      },
    });

    expect(await renewing.sweep()).toEqual({ ...NOTHING, claimed: 1, ran: 1 });

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.id).not.toBe(before?.id ?? '');
    expect(store.rows[0]?.attempts).toBe(0);
    expect(store.rows[0]?.lockToken).toBeNull();
    expect(store.rows[0]?.runAt).toEqual(new Date(NOW.getTime() + 3600_000));
  });

  test('a handler that reschedules itself and then throws is not retried on top of its successor', async () => {
    await scheduleModuleJob();

    const throwing = sweeper({
      runModuleJob: async (job) => {
        ran.push(job);
        await job.reschedule({
          guildId: GUILD,
          runAt: new Date(clock.getTime() + 3600_000),
          kind: 'module_job',
          idempotencyKey: job.idempotencyKey,
          payload: {
            kind: 'module',
            moduleId: job.moduleId,
            jobId: job.jobId,
            guildId: GUILD,
            data: { text: 'next' },
          },
        });
        throw new Error('the reminder channel is gone');
      },
    });

    expect(await throwing.sweep()).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });

    const [broken] = logger.matching('error', 'booked its next run and then failed');
    expect(broken?.message).toContain('the reminder channel is gone');

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.attempts).toBe(0);
    expect(store.rows[0]?.runAt).toEqual(new Date(NOW.getTime() + 3600_000));
  });

  test('a handler that lost its row is refused the reschedule rather than resurrecting the row', async () => {
    await scheduleModuleJob();

    let refused: CompleteOutcome | undefined;
    const losing = sweeper({
      renewMs: NEVER,
      runModuleJob: async (job) => {
        ran.push(job);
        await store.cancel(job.idempotencyKey);
        refused = await job.reschedule({
          guildId: GUILD,
          runAt: new Date(clock.getTime() + 3600_000),
          kind: 'module_job',
          idempotencyKey: job.idempotencyKey,
          payload: {
            kind: 'module',
            moduleId: job.moduleId,
            jobId: job.jobId,
            guildId: GUILD,
            data: { text: 'next' },
          },
        });
      },
    });

    expect(await losing.sweep()).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });

    expect(refused).toBe('lost');
    expect(store.rows).toHaveLength(0);
    expect(logger.matching('error', 'left the row untouched')).toHaveLength(1);
  });
});

describe('ScheduledActionSweeper reversal arm', () => {
  test('still executes the reversal, stamps its case and retires the row', async () => {
    await scheduleReversal();

    expect(await sweeper({ runModuleJob: collect }).sweep()).toEqual({
      ...NOTHING,
      claimed: 1,
      reverted: 1,
    });

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.kind).toBe('unban');
    expect(executor.requests[0]?.idempotencyKey).toBe('reversal:abc');
    expect(store.reverted).toEqual([
      { caseId: 'case-1', revertedAt: NOW, revertedBy: 'proton:auto-reversal' },
    ]);
    expect(store.rows).toHaveLength(0);
    expect(ran).toHaveLength(0);
  });

  test('leaves the case alone when the reversal itself failed', async () => {
    await scheduleReversal();
    executor.result = {
      status: 'failed_api',
      failure: { code: 'discord_error', humanReason: 'Discord answered 500' },
    };

    expect((await sweeper().sweep()).retrying).toBe(1);

    expect(store.reverted).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
  });

  test('a reversal outliving its lock keeps its row too: the reversal arm renews the same lease', async () => {
    await scheduleReversal();
    const upstream = gate();
    executor.hold = upstream.opened;

    let renewals = 0;
    const renewed = new Promise<void>((resolve) => {
      store.onRenew = () => {
        clock = new Date(clock.getTime() + LOCK_MS / 2);
        renewals += 1;
        if (renewals === 4) resolve();
      };
    });

    const overrunning = sweeper({ renewMs: 1 }).sweep();
    await Promise.race([renewed, Bun.sleep(2000)]);

    expect(renewals).toBeGreaterThanOrEqual(4);
    expect(await sweeper().sweep()).toEqual(NOTHING);

    upstream.open();
    expect(await overrunning).toEqual({ ...NOTHING, claimed: 1, reverted: 1 });

    expect(store.reverted).toHaveLength(1);
    expect(store.rows).toHaveLength(0);
  });

  test('a reversal whose lock lapsed under it neither stamps its case nor unlocks the row', async () => {
    await scheduleReversal();
    const upstream = gate();
    const reached = gate();
    executor.hold = upstream.opened;
    executor.onExecute = () => reached.open();

    const overrunning = sweeper({ renewMs: NEVER }).sweep();
    await Promise.race([reached.opened, Bun.sleep(2000)]);

    clock = new Date(clock.getTime() + LOCK_MS + 1);
    upstream.open();

    expect(await overrunning).toEqual({ ...NOTHING, claimed: 1, aborted: 1 });

    expect(store.reverted).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.lockToken).not.toBeNull();
    expect(logger.matching('error', 'left the row untouched')).toHaveLength(1);
  });
});

describe('ScheduledActionSweeper payload dispatch', () => {
  test('a payload matching neither arm is retried, not silently dropped', async () => {
    store.rows.push({
      id: 'row-junk',
      guildId: GUILD,
      runAt: new Date(clock.getTime() - 1000),
      kind: 'unban',
      attempts: 0,
      idempotencyKey: 'junk',
      payload: { kind: 'wat' },
      lockedUntil: null,
      lockToken: null,
    });

    expect((await sweeper({ runModuleJob: collect }).sweep()).retrying).toBe(1);

    expect(logger.matching('warn', 'no longer matches the expected shape')).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(ran).toHaveLength(0);
    expect(executor.requests).toHaveLength(0);
  });

  test('a row written before the payload carried a discriminator reverts, it is not abandoned', async () => {
    store.rows.push({
      id: 'row-legacy',
      guildId: GUILD,
      runAt: new Date(clock.getTime() - 1000),
      kind: 'unban',
      attempts: 0,
      idempotencyKey: 'reversal:legacy',
      payload: {
        caseId: 'case-legacy',
        moduleId: 'moderation',
        actorId: '100000000000000000',
        targetId: '400000000000000000',
        originalKind: 'ban',
        action: { userId: '400000000000000000' },
      },
      lockedUntil: null,
      lockToken: null,
    });

    expect((await sweeper({ runModuleJob: collect }).sweep()).reverted).toBe(1);

    expect(executor.requests).toHaveLength(1);
    expect(executor.requests[0]?.kind).toBe('unban');
    expect(executor.requests[0]?.payload).toEqual({ userId: '400000000000000000' });
    expect(store.reverted).toEqual([
      { caseId: 'case-legacy', revertedAt: NOW, revertedBy: 'proton:auto-reversal' },
    ]);
    expect(store.rows).toHaveLength(0);
  });
});
