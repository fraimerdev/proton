import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type ActionResult,
  DefaultActionExecutor,
  type GuildState,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import {
  createSyncBatchHandler,
  JOINROLES_SYNC_JOB,
  SYNC_ATTEMPTS,
  SYNC_GRANTS_PER_TICK,
  SYNC_RETRY_BASE_MS,
  SYNC_TICK_BUDGET_MS,
} from '../src/sync/run.ts';
import { syncFingerprint } from '../src/sync/view.ts';
import { config, GUILD, PROTON, ROLE_ABOVE_BOT, ROLE_LOW, ROLE_MID } from './harness.ts';
import { NOW, OWNER, summary, syncHarness, syncState, user } from './sync-harness.ts';

type Harness = ReturnType<typeof syncHarness>;

async function batch(h: Harness, overrides: Parameters<Harness['ctx']>[0] = {}): Promise<void> {
  await createSyncBatchHandler(h.deps)(
    undefined,
    h.ctx({ memberRoleIds: [ROLE_LOW], ...overrides }),
  );
}

function without(roleId: string): GuildState {
  const state = syncState();
  state.roles.delete(roleId);
  return state;
}

function movedAboveProton(roleId: string): GuildState {
  const state = syncState();
  state.roles.set(roleId, { id: roleId, permissions: 0n, position: 60 });
  return state;
}

describe('a sync batch', () => {
  test('grants every missing role and counts members, not roles', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [
      summary(user(1)),
      summary(user(2), [ROLE_LOW]),
      summary(user(3), [ROLE_MID]),
      summary(user(4), [], { bot: true }),
      summary(PROTON),
    ];

    await batch(h, { memberRoleIds: [ROLE_LOW, ROLE_MID], botRoleIds: [ROLE_MID] });

    expect(
      h.executor.requests.map((r) => [r.targetId, (r.payload as { roleId: string }).roleId]),
    ).toEqual([
      [user(1), ROLE_LOW],
      [user(1), ROLE_MID],
      [user(2), ROLE_MID],
      [user(3), ROLE_LOW],
      [user(4), ROLE_MID],
    ]);

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('done');
    expect(last?.updated).toBe(4);
    expect(last?.processed).toBe(4);
    expect(await h.runs.get(GUILD)).toBeNull();
  });

  test('never records a case, names the trigger, and keys each grant to the run', async () => {
    const h = syncHarness();
    h.queue({ trigger: 'schedule', runId: 's123', actorId: null });
    h.lister.members = [summary(user(1))];

    await batch(h);

    const [request] = h.executor.requests;
    expect(request?.record).toBe(false);
    expect(request?.dryRun).toBe(false);
    expect(request?.reason).toBe('Join Roles sync (scheduled)');
    expect(request?.idempotencyKey).toBe(`joinroles:${GUILD}:sync:s123:${user(1)}:${ROLE_LOW}`);

    const dashboard = syncHarness();
    dashboard.queue();
    dashboard.lister.members = [summary(user(1))];
    await batch(dashboard);
    expect(dashboard.executor.requests[0]?.reason).toBe('Join Roles sync (dashboard)');
  });

  test('ranks each member from the page it read, not a second fetch', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1), [ROLE_MID])];

    await batch(h);

    expect(h.executor.scopes).toEqual([{ targetRoleIds: [ROLE_MID] }]);
  });

  test('stops at the grant budget and carries the cursor into the next batch', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = Array.from({ length: 30 }, (_, i) => summary(user(i + 1)));

    await batch(h);

    expect(h.executor.requests).toHaveLength(SYNC_GRANTS_PER_TICK);
    const run = await h.runs.get(GUILD);
    expect(run?.after).toBe(user(SYNC_GRANTS_PER_TICK));
    expect(run?.state).toBe('running');
    expect(run?.updated).toBe(SYNC_GRANTS_PER_TICK);
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toMatchObject({
      runAt: NOW,
      naturalKey: 'joinroles:sync:run-1',
      data: { runId: 'run-1' },
      replace: true,
    });

    await batch(h);

    expect(h.executor.requests).toHaveLength(30);
    expect(h.lister.asked).toEqual(['0', user(SYNC_GRANTS_PER_TICK)]);
    expect((await h.runs.last(GUILD))?.updated).toBe(30);
  });

  test('a redone batch counts its own grants as updated without granting twice', async () => {
    const h = syncHarness();
    const queued = h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];

    await batch(h);
    h.runs.seed(queued);
    await batch(h);

    expect(h.executor.applied).toHaveLength(2);
    expect((await h.runs.last(GUILD))?.updated).toBe(2);
  });

  test('a slow member list still leaves the batch its whole budget', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = Array.from({ length: 3 }, (_, i) => summary(user(i + 1)));
    const list = h.lister.list.bind(h.lister);
    h.lister.list = async (guildId, after, limit) => {
      h.clock.now += SYNC_TICK_BUDGET_MS;
      return list(guildId, after, limit);
    };

    await batch(h);

    expect(h.executor.targets()).toEqual([user(1), user(2), user(3)]);
    expect((await h.runs.last(GUILD))?.outcome).toBe('done');
  });

  test('a batch always gets past one member, however slow the grants are', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = Array.from({ length: 3 }, (_, i) => summary(user(i + 1)));
    h.executor.beforeEach = async () => {
      h.clock.now += SYNC_TICK_BUDGET_MS;
    };

    for (let i = 0; i < 3; i += 1) await batch(h);

    expect(h.executor.targets()).toEqual([user(1), user(2), user(3)]);
    expect(h.lister.asked).toEqual(['0', user(1), user(2)]);
    expect((await h.runs.last(GUILD))?.updated).toBe(3);
  });

  test('a batch booked for an earlier run leaves the current one alone', async () => {
    const h = syncHarness();
    const current = h.queue({ runId: 'run-2' });
    h.lister.members = [summary(user(1))];

    await createSyncBatchHandler(h.deps)({ runId: 'run-1' }, h.ctx({ memberRoleIds: [ROLE_LOW] }));

    expect(h.lister.asked).toEqual([]);
    expect(h.executor.requests).toEqual([]);
    expect(await h.runs.get(GUILD)).toEqual(current);
    expect(h.scheduler.calls).toEqual([]);
  });

  test('moves queued to running with the server’s member count', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = Array.from({ length: 26 }, (_, i) => summary(user(i + 1)));

    await batch(h);

    const run = await h.runs.get(GUILD);
    expect(run?.total).toBe(5000);
    expect(run?.startedAt).toBe(NOW);
  });
});

describe('who a sync leaves alone', () => {
  test('a member in Membership Screening is marked for later while the wait is on', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1), [], { pending: true })];

    await batch(h);

    expect(h.executor.requests).toEqual([]);
    expect(h.pending.marked).toEqual([user(1)]);
    expect((await h.runs.last(GUILD))?.skipped.pending).toBe(1);
  });

  test('with the wait off, a member in Membership Screening is granted like anyone', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1), [], { pending: true })];

    await batch(h, { grantWhenScreeningPasses: false });

    expect(h.executor.targets()).toEqual([user(1)]);
    expect(h.pending.marked).toEqual([]);
  });

  test('a member ranked above Proton and the owner are skipped, and the sync carries on', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(OWNER), summary(user(3))];
    h.executor.respond = (request) => {
      if (request.targetId === user(1)) {
        return {
          status: 'failed_precheck',
          failure: { code: 'role_hierarchy', humanReason: 'above me' },
        };
      }
      if (request.targetId === OWNER) {
        return {
          status: 'failed_precheck',
          failure: { code: 'target_is_owner', humanReason: 'owner' },
        };
      }
      return undefined;
    };

    await batch(h);

    const last = await h.runs.last(GUILD);
    expect(last?.skipped.outranks).toBe(1);
    expect(last?.skipped.owner).toBe(1);
    expect(last?.updated).toBe(1);
  });

  test.each([
    [
      'Unknown Member',
      {
        status: 'failed_api',
        failure: { code: 'discord_404', humanReason: 'gone', discordCode: 10007 },
      },
    ],
    [
      'Unknown User',
      {
        status: 'failed_api',
        failure: { code: 'discord_404', humanReason: 'gone', discordCode: 10013 },
      },
    ],
    [
      'a precheck that found no member',
      { status: 'failed_precheck', failure: { code: 'target_not_member', humanReason: 'gone' } },
    ],
  ] as const)('a member who left during the sync is counted as left: %s', async (_name, gone) => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];
    h.executor.respond = (request) => (request.targetId === user(1) ? gone : undefined);

    await batch(h);

    const last = await h.runs.last(GUILD);
    expect(last?.skipped.left).toBe(1);
    expect(last?.updated).toBe(1);
  });

  test.each([
    ['Discord gave another code', { discordCode: 10004 }],
    ['carries no Discord code, so Discord did not send it', {}],
  ] as const)('a 404 that %s is a failed grant, not a member who left', async (_name, extra) => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];
    h.executor.respond = (request) =>
      request.targetId === user(1)
        ? {
            status: 'failed_api',
            failure: { code: 'discord_404', humanReason: 'Not found', ...extra },
          }
        : undefined;

    await batch(h);

    const last = await h.runs.last(GUILD);
    expect(last?.skipped.left).toBe(0);
    expect(last?.skipped.failed).toBe(1);
    expect(last?.updated).toBe(1);
    expect(h.lines.some((line) => line.includes(`could not give role ${ROLE_LOW}`))).toBe(true);
  });

  test('a skip role keeps a member out of the sync only while the switch is on', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1), [ROLE_MID])];

    await batch(h, { syncExcludeEnabled: true, syncExcludeRoleIds: [ROLE_MID] });
    expect(h.executor.requests).toEqual([]);
    expect((await h.runs.last(GUILD))?.skipped.excluded).toBe(1);

    h.queue({ runId: 'run-2' });
    await batch(h, { syncExcludeEnabled: false, syncExcludeRoleIds: [ROLE_MID] });
    expect(h.executor.targets()).toEqual([user(1)]);
  });
});

describe('what stops a sync', () => {
  test('a missing Manage Roles mid-run stops it with no further grants', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    h.executor.respond = (request) =>
      request.targetId === user(2)
        ? {
            status: 'failed_precheck',
            failure: { code: 'missing_permission', humanReason: 'no Manage Roles' },
          }
        : undefined;

    await batch(h);

    expect(h.executor.targets()).toEqual([user(1), user(2)]);
    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('failed');
    expect(last?.failure?.code).toBe('missing_permission');
    expect(last?.failure?.message).toContain('Manage Roles');
    expect(last?.updated).toBe(1);
    expect(await h.runs.get(GUILD)).toBeNull();
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toBeUndefined();
  });

  test.each([
    ['a real 403', { status: 'failed_api', failure: { code: 'discord_403', humanReason: 'no' } }],
    [
      'Missing Permissions',
      {
        status: 'failed_api',
        failure: { code: 'discord_403', humanReason: 'no', discordCode: 50013 },
      },
    ],
  ] as const)('the first refusal stops the run: %s', async (_name, refusal) => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];
    h.executor.respond = () => refusal;

    await batch(h);

    expect(h.executor.requests).toHaveLength(1);
    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('failed');
    expect(last?.failure?.code).toBe('role_refused');
    expect(last?.failure?.roleId).toBe(ROLE_LOW);
    expect(last?.failure?.message).toContain("Proton's role");
  });

  test('a 5xx ends the batch without moving past that member, then retries', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    h.executor.respond = (request) =>
      request.targetId === user(2)
        ? { status: 'failed_api', failure: { code: 'discord_502', humanReason: 'trouble' } }
        : undefined;

    await batch(h);

    const run = await h.runs.get(GUILD);
    expect(run?.after).toBe(user(1));
    expect(run?.failures).toBe(1);
    expect(h.executor.targets()).toEqual([user(1), user(2)]);
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)?.runAt).toBe(NOW + SYNC_RETRY_BASE_MS * 2);
  });

  test('a member list that stays unreadable is retried, then the run fails', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1))];
    for (let i = 0; i < SYNC_ATTEMPTS; i += 1) {
      h.lister.failures.push({ failure: 'Discord answered 500', retryable: true });
    }

    for (let i = 1; i < SYNC_ATTEMPTS; i += 1) {
      await batch(h);
      expect((await h.runs.get(GUILD))?.failures).toBe(i);
    }

    await batch(h);

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('failed');
    expect(last?.failure?.code).toBe('member_list_unavailable');
    expect(h.executor.requests).toEqual([]);
  });

  test('a lister that throws is retried like an unreadable page', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.throws = new Error('fetch failed');

    await batch(h);

    expect((await h.runs.get(GUILD))?.failures).toBe(1);
  });

  test('a Server Members intent refusal fails at once with the intent message', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.failures.push({ failure: 'intent refused', retryable: false });

    await batch(h);

    const last = await h.runs.last(GUILD);
    expect(last?.failure?.code).toBe('member_list_refused');
    expect(last?.failure?.message).toContain("Discord wouldn't let Proton read the member list");
  });

  test('missing guild state retries instead of failing', async () => {
    const h = syncHarness();
    h.queue();
    h.state.current = null;

    await batch(h);

    expect((await h.runs.get(GUILD))?.failures).toBe(1);
    expect(await h.runs.last(GUILD)).toBeNull();
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toBeDefined();
  });

  test('a preflight failure ends the run before any member is read', async () => {
    const h = syncHarness();
    h.queue();
    h.state.current = syncState(0n);
    h.lister.members = [summary(user(1))];

    await batch(h);

    expect(h.lister.asked).toEqual([]);
    expect((await h.runs.last(GUILD))?.failure?.message).toContain('Manage Roles');
  });

  test('a role above Proton is reported as blocked and the rest still sync', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1))];

    await batch(h, { memberRoleIds: [ROLE_LOW, ROLE_ABOVE_BOT] });

    expect(h.executor.requests).toHaveLength(1);
    expect((await h.runs.last(GUILD))?.blockedRoles).toEqual([
      { roleId: ROLE_ABOVE_BOT, code: 'above_proton' },
    ]);
  });

  test('a batch cannot bring back a run that was stopped while it worked', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = Array.from({ length: 30 }, (_, i) => summary(user(i + 1)));
    h.executor.beforeEach = async (request) => {
      if (request.targetId === user(2)) await h.runs.clear(GUILD, 'run-1');
    };

    await batch(h);

    expect(await h.runs.get(GUILD)).toBeNull();
    expect(await h.runs.last(GUILD)).toBeNull();
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)).toBeUndefined();
  });

  test('a batch with no scheduler fails the run before granting anything', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1))];

    await createSyncBatchHandler(h.deps)(
      undefined,
      h.ctx({ memberRoleIds: [ROLE_LOW] }, { schedule: false }),
    );

    expect(h.executor.requests).toEqual([]);
    expect((await h.runs.last(GUILD))?.failure?.code).toBe('no_scheduler');
  });
});

describe('a join role that changes during a sync', () => {
  const both = { memberRoleIds: [ROLE_LOW, ROLE_MID] };

  const unknownRole = (request: ActionRequest): ActionResult | undefined =>
    request.targetId === user(2) && (request.payload as { roleId: string }).roleId === ROLE_MID
      ? {
          status: 'failed_api',
          failure: { code: 'discord_404', humanReason: 'Unknown Role', discordCode: 10011 },
        }
      : undefined;

  test('a deleted role ends the batch before that member, and is never counted as a member who left', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    h.executor.respond = unknownRole;

    await batch(h, both);

    const run = await h.runs.get(GUILD);
    expect(run?.after).toBe(user(1));
    expect(run?.skipped.left).toBe(0);
    expect(run?.updated).toBe(1);
    expect(run?.failures).toBe(1);
    expect(h.executor.targets()).toEqual([user(1), user(1), user(2), user(2)]);
    expect(h.scheduler.booked(JOINROLES_SYNC_JOB)?.runAt).toBe(NOW + SYNC_RETRY_BASE_MS * 2);
    expect(h.lines.some((line) => line.includes('no longer exists, so the sync stopped'))).toBe(
      true,
    );
  });

  test('the next batch blocks the deleted role and gives the others to everyone left', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    h.executor.respond = unknownRole;

    await batch(h, both);
    h.state.current = without(ROLE_MID);
    await batch(h, both);

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('done');
    expect(last?.blockedRoles).toEqual([{ roleId: ROLE_MID, code: 'missing' }]);
    expect(last?.updated).toBe(3);
    expect(last?.skipped.left).toBe(0);
    expect(
      h.executor.applied.map((r) => [r.targetId, (r.payload as { roleId: string }).roleId]),
    ).toEqual([
      [user(1), ROLE_LOW],
      [user(1), ROLE_MID],
      [user(2), ROLE_LOW],
      [user(3), ROLE_LOW],
    ]);
  });

  test('a role Discord keeps calling unknown stops the run after the usual attempts, naming it', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];
    h.executor.respond = unknownRole;

    for (let i = 0; i < SYNC_ATTEMPTS; i += 1) await batch(h, both);

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('failed');
    expect(last?.failure).toEqual({
      code: 'role_missing',
      roleId: ROLE_MID,
      message:
        `The join role with ID ${ROLE_MID} no longer exists, so the sync stopped there. Remove it ` +
        'from Member roles or Bot roles.',
    });
    expect(last?.skipped.left).toBe(0);
  });

  test('every log line about a role that stopped the sync carries that role', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];
    h.executor.respond = unknownRole;
    const logged: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
    const push = (message: string, meta?: Record<string, unknown>) => {
      logged.push({ message, meta });
    };

    for (let i = 0; i < SYNC_ATTEMPTS; i += 1) {
      await createSyncBatchHandler(h.deps)(undefined, {
        ...h.ctx(both),
        logger: { info: push, warn: push, error: push },
      });
    }

    const aboutTheRole = logged.filter(({ message }) => message.includes('no longer exists'));
    expect(aboutTheRole.map(({ message }) => message.slice(0, 26))).toEqual([
      ...Array.from({ length: SYNC_ATTEMPTS - 1 }, () => 'a Join Roles sync could no'),
      'Join Roles sync failed: 1 ',
    ]);
    for (const { message, meta } of aboutTheRole) {
      expect(message).toContain(`The join role with ID ${ROLE_MID}`);
      expect(meta).toMatchObject({ guildId: GUILD, roleId: ROLE_MID });
    }
  });

  test('a role moved above Proton is a role problem, not members who outrank Proton', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    h.executor.respond = (request) => {
      if ((request.payload as { roleId: string }).roleId !== ROLE_MID) return undefined;
      if (request.targetId === user(1)) {
        h.state.current = movedAboveProton(ROLE_MID);
        return undefined;
      }
      return {
        status: 'failed_precheck',
        failure: { code: 'role_hierarchy', humanReason: 'The role is above mine.' },
      };
    };

    await batch(h, both);

    const run = await h.runs.get(GUILD);
    expect(run?.after).toBe(user(1));
    expect(run?.skipped.outranks).toBe(0);
    expect(
      h.lines.some((line) =>
        line.includes(`The join role with ID ${ROLE_MID} is now at or above Proton's highest role`),
      ),
    ).toBe(true);

    await batch(h, both);

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('done');
    expect(last?.blockedRoles).toEqual([{ roleId: ROLE_MID, code: 'above_proton' }]);
    expect(last?.skipped.outranks).toBe(0);
    expect(last?.updated).toBe(3);
  });

  test('a role Proton still ranks above means the member outranks Proton', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1), [ROLE_ABOVE_BOT]), summary(user(2))];
    h.executor.respond = (request) =>
      request.targetId === user(1)
        ? {
            status: 'failed_precheck',
            failure: { code: 'role_hierarchy', humanReason: "That member's highest role…" },
          }
        : undefined;

    await batch(h, both);

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('done');
    expect(last?.skipped.outranks).toBe(1);
    expect(last?.blockedRoles).toEqual([]);
  });

  test('a server whose roles cannot be re-read retries rather than guessing who outranks whom', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2))];
    h.executor.respond = (request) => {
      if (request.targetId !== user(2)) return undefined;
      h.state.current = null;
      return {
        status: 'failed_precheck',
        failure: { code: 'role_hierarchy', humanReason: 'above me' },
      };
    };

    await batch(h);

    const run = await h.runs.get(GUILD);
    expect(run?.after).toBe(user(1));
    expect(run?.skipped.outranks).toBe(0);
    expect(h.lines.some((line) => line.includes("couldn't load this server's roles"))).toBe(true);
  });
});

describe('a join role that changes during a sync, against the real executor', () => {
  const both = { memberRoleIds: [ROLE_LOW, ROLE_MID] };

  class FakeRest implements RestProxyClient {
    readonly calls: RestRequestOptions[] = [];
    answer: (options: RestRequestOptions) => RestResponse | undefined = () => undefined;

    async request(options: RestRequestOptions): Promise<RestResponse> {
      this.calls.push(options);
      return this.answer(options) ?? { status: 204, body: null };
    }

    puts(): string[] {
      return this.calls.filter((call) => call.method === 'PUT').map((call) => call.path);
    }
  }

  function live() {
    const h = syncHarness();
    const rest = new FakeRest();
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
      rest,
      recorder: {
        record: async () => {
          throw new Error('a sync must never write a case');
        },
      },
      resolveContext: async (request, hints) => {
        const resolved = await resolvePrecheckContext(
          {
            store: {
              get: async () => h.state.current,
              put: async () => undefined,
              patch: async () => undefined,
              delete: async () => undefined,
            },
            botUserId: PROTON,
            fetchMemberRoles: async () => null,
          },
          request,
          (hints ?? {}) as ResolveContextHints,
        );
        return 'context' in resolved ? resolved.context : resolved;
      },
    });

    const run = (overrides: Parameters<Harness['ctx']>[0] = both) =>
      createSyncBatchHandler(h.deps)(undefined, { ...h.ctx(overrides), executor });

    return { h, rest, run };
  }

  const grant = (userId: string, roleId: string) =>
    `/guilds/${GUILD}/members/${userId}/roles/${roleId}`;

  test('Discord’s Unknown Role pauses the sync until the role list catches up, then carries on', async () => {
    const { h, rest, run } = live();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    rest.answer = (options) =>
      options.path === grant(user(2), ROLE_MID)
        ? { status: 404, body: { message: 'Unknown Role', code: 10011 } }
        : undefined;

    await run();

    expect((await h.runs.get(GUILD))?.after).toBe(user(1));

    h.state.current = without(ROLE_MID);
    await run();

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('done');
    expect(last?.skipped.left).toBe(0);
    expect(last?.blockedRoles).toEqual([{ roleId: ROLE_MID, code: 'missing' }]);
    expect(rest.puts()).toEqual([
      grant(user(1), ROLE_LOW),
      grant(user(1), ROLE_MID),
      grant(user(2), ROLE_LOW),
      grant(user(2), ROLE_MID),
      grant(user(3), ROLE_LOW),
    ]);
  });

  test('a role moved above Proton mid-batch is refused before Discord and blocked by the next batch', async () => {
    const { h, rest, run } = live();
    h.queue();
    h.lister.members = [summary(user(1)), summary(user(2)), summary(user(3))];
    rest.answer = (options) => {
      if (options.path === grant(user(1), ROLE_MID)) h.state.current = movedAboveProton(ROLE_MID);
      return undefined;
    };

    await run();

    const paused = await h.runs.get(GUILD);
    expect(paused?.after).toBe(user(1));
    expect(paused?.skipped.outranks).toBe(0);

    await run();

    const last = await h.runs.last(GUILD);
    expect(last?.outcome).toBe('done');
    expect(last?.skipped.outranks).toBe(0);
    expect(last?.blockedRoles).toEqual([{ roleId: ROLE_MID, code: 'above_proton' }]);
    expect(rest.puts()).toEqual([
      grant(user(1), ROLE_LOW),
      grant(user(1), ROLE_MID),
      grant(user(2), ROLE_LOW),
      grant(user(3), ROLE_LOW),
    ]);
  });
});

describe('counting and finishing', () => {
  test('a count reads the member list, grants nothing and writes the estimate', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });
    h.lister.members = [
      summary(user(1)),
      summary(user(2), [ROLE_LOW]),
      summary(user(3), [], { pending: true }),
      summary(user(4), [ROLE_MID]),
      summary(PROTON),
    ];

    await batch(h, { syncExcludeEnabled: true, syncExcludeRoleIds: [ROLE_MID] });

    expect(h.executor.requests).toEqual([]);
    expect(h.pending.marked).toEqual([]);
    expect(await h.runs.last(GUILD)).toBeNull();

    const estimate = await h.runs.estimate(GUILD);
    expect(estimate).toMatchObject({
      missing: 2,
      pending: 1,
      scanned: 4,
      countedAt: NOW,
      source: 'count',
      failure: null,
    });
    expect(estimate?.fingerprint).toBe(
      syncFingerprint(
        config({
          memberRoleIds: [ROLE_LOW],
          syncExcludeEnabled: true,
          syncExcludeRoleIds: [ROLE_MID],
        }),
      ),
    );
  });

  test('a finished sync writes the last sync, the estimate of who is still missing, and clears', async () => {
    const h = syncHarness();
    h.queue();
    h.lister.members = [
      summary(user(1)),
      summary(user(2), [], { pending: true }),
      summary(user(3)),
      summary(OWNER),
    ];
    h.executor.respond = (request) => {
      if (request.targetId === user(3)) {
        return {
          status: 'failed_precheck',
          failure: { code: 'role_hierarchy', humanReason: 'above me' },
        };
      }
      if (request.targetId === OWNER) {
        return {
          status: 'failed_precheck',
          failure: { code: 'target_is_owner', humanReason: 'owner' },
        };
      }
      return undefined;
    };

    await batch(h);

    expect(await h.runs.get(GUILD)).toBeNull();
    expect(await h.runs.last(GUILD)).toMatchObject({
      runId: 'run-1',
      trigger: 'dashboard',
      outcome: 'done',
      failure: null,
      processed: 4,
      updated: 1,
      startedAt: NOW,
      finishedAt: NOW,
    });
    expect(await h.runs.estimate(GUILD)).toMatchObject({ missing: 3, pending: 1, source: 'sync' });
  });

  test('a count spreads a large server across batches of pages', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });
    h.lister.members = Array.from({ length: 5500 }, (_, i) => summary(user(i + 1)));

    await batch(h);

    expect(h.lister.asked).toHaveLength(5);
    expect((await h.runs.get(GUILD))?.processed).toBe(5000);

    await batch(h);

    expect((await h.runs.estimate(GUILD))?.missing).toBe(5500);
  });

  test('a failed count writes the failure into the estimate, not a last sync', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });
    h.lister.failures.push({ failure: 'intent refused', retryable: false });

    await batch(h);

    expect(await h.runs.last(GUILD)).toBeNull();
    expect((await h.runs.estimate(GUILD))?.failure?.code).toBe('member_list_refused');
  });

  test('a count that stops says the count stopped, not a sync', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });
    for (let i = 0; i < SYNC_ATTEMPTS; i += 1) {
      h.lister.failures.push({ failure: 'Discord answered 500', retryable: true });
    }

    for (let i = 0; i < SYNC_ATTEMPTS; i += 1) await batch(h);

    expect((await h.runs.estimate(GUILD))?.failure).toEqual({
      code: 'member_list_unavailable',
      message: "Discord didn't return the member list, so the count stopped. Try again later.",
    });
  });

  test('a count refused by the preflight asks the admin to count again', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });
    h.state.current = syncState(0n);

    await batch(h);

    const failure = (await h.runs.estimate(GUILD))?.failure;
    expect(failure?.code).toBe('missing_permission');
    expect(failure?.message).toContain('Manage Roles');
    expect(failure?.message).toEndWith('then count again.');
    expect(failure?.message).not.toContain('sync');
  });

  test('a count with no roles saved has nothing to count', async () => {
    const h = syncHarness();
    h.queue({ kind: 'count' });

    await batch(h, { memberRoleIds: [] });

    expect((await h.runs.estimate(GUILD))?.failure?.message).toBe(
      'No member or bot roles are set, so there is nothing to count. Choose them and save first.',
    );
  });
});
