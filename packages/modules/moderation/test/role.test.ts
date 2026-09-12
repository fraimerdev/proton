import { describe, expect, test } from 'bun:test';
import { moderationModule } from '../src/index.ts';
import { ROLE_RUN_JOB, ROLE_RUN_KEY } from '../src/role-run.ts';
import type { RoleRun } from '../src/run-store.ts';
import {
  ABOVE_BOT,
  APPLICATION_ID,
  CHANNEL,
  EVERYONE_ROLE,
  GRANT_ROLE,
  GUILD,
  HIGH_ROLE,
  harness,
  LOW_ROLE,
  MANAGED_ROLE,
  MEMBER,
  MOD_ROLE,
  MODERATOR,
  member,
  roleOption,
  stringOption,
  subcommand,
  userOption,
} from './harness.ts';

const BOT_MEMBER = '400000000000000010';
const OTHER_MEMBER = '400000000000000011';

function run(overrides: Partial<RoleRun> = {}): RoleRun {
  return {
    runId: 'run-1',
    guildId: GUILD,
    roleId: GRANT_ROLE,
    mode: 'all',
    actorId: MODERATOR,
    actorRoleIds: [MOD_ROLE],
    channelId: CHANNEL,
    messageId: '700000000000000001',
    after: '0',
    scanned: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    listFailures: 0,
    startedAt: 0,
    cancelled: false,
    ...overrides,
  };
}

describe('/role registration', () => {
  test('carries every subcommand the moderation module ships it with', () => {
    const role = moderationModule.commands?.find((c) => c.name === 'role');

    expect((role?.data.options ?? []).map((o) => o.name)).toEqual([
      'add',
      'remove',
      'all',
      'bots',
      'humans',
      'in',
      'cancel',
    ]);
  });

  test('asks for Manage Roles and Moderate Members together', () => {
    const role = moderationModule.commands?.find((c) => c.name === 'role');

    // 0x10000000 | 0x0000010000000000 — both bits, so Discord's default gate needs both.
    expect(role?.data.default_member_permissions).toBe(String((1n << 28n) | (1n << 40n)));
  });
});

describe('/role add and /role remove', () => {
  test('adds a role below both the bot and the invoker', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [
        userOption('user', MEMBER),
        roleOption('role', GRANT_ROLE),
        stringOption('reason', 'helper'),
      ]),
    );

    const [call] = h.discordCalls();
    expect(call?.method).toBe('PUT');
    expect(call?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}/roles/${GRANT_ROLE}`);
    expect(call?.headers?.['x-audit-log-reason']).toBe('helper');
    expect(h.cases()[0]?.kind).toBe('add_role');
    expect(h.replyContent()).toContain('Gave');
  });

  test('removes a role', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('remove', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
    );

    expect(h.discordCalls()[0]?.method).toBe('DELETE');
    expect(h.cases()[0]?.kind).toBe('remove_role');
    expect(h.replyContent()).toContain('Took');
  });

  test('refuses a role above the invoker’s own highest, naming why', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', MOD_ROLE)]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('your own highest role');
  });

  test('lets the server owner hand out a role they do not themselves hold', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', MOD_ROLE)]),
      { actorRoleIds: [] },
    );

    expect(h.replyContent()).toContain('your own highest role');

    const owner = harness();
    await owner.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', MOD_ROLE)]),
      { actorRoleIds: [], asOwner: true },
    );

    expect(owner.discordCalls()).toHaveLength(1);
  });

  test('refuses a role above the bot before it looks at the invoker', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', HIGH_ROLE)]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('my own highest role');
  });

  test('refuses a managed role, because nobody can assign one', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', MANAGED_ROLE)]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('managed by Discord');
  });

  test('refuses @everyone rather than sending Discord a request it always rejects', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', EVERYONE_ROLE)]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('@everyone');
  });

  test('refuses when it cannot read the invoker’s roles, rather than assuming they outrank it', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
      { actorRoleIds: undefined },
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('read your own roles');
  });

  // Discord refuses a role change unless the actor outranks the member being edited, not just the
  // role being moved. The executor only ever ranks the target against Proton.
  test('refuses a target who outranks the invoker, even when the role itself is fine', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', ABOVE_BOT), roleOption('role', GRANT_ROLE)]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.cases()).toEqual([]);
    expect(h.replyContent()).toContain('above or equal to your own');
  });

  test('lets the invoker change the roles of somebody they outrank', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
    );

    expect(h.discordCalls()).toHaveLength(1);
  });

  test('still applies the executor’s own bot-side check, for an owner nothing else stops', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', ABOVE_BOT), roleOption('role', GRANT_ROLE)]),
      { asOwner: true },
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('above or equal to mine');
  });

  test('lets a moderator change their own roles, which Discord also allows', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MODERATOR), roleOption('role', GRANT_ROLE)]),
    );

    expect(h.discordCalls()).toHaveLength(1);
  });

  test('honours the server’s require-reason policy', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
      { config: { requireReason: true } },
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('requires a reason');
  });
});

describe('/role all, bots, humans and in', () => {
  test('posts a progress message, stores the run and books the first chunk', async () => {
    const h = harness();

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]));

    const posted = h.discordCalls()[0];
    expect(posted?.method).toBe('POST');
    expect(posted?.path).toBe(`/channels/${CHANNEL}/messages`);

    const stored = await h.roleRuns.get(GUILD);
    expect(stored?.roleId).toBe(GRANT_ROLE);
    expect(stored?.mode).toBe('all');
    expect(stored?.after).toBe('0');

    expect(h.jobs).toEqual([
      { jobId: ROLE_RUN_JOB, runAt: expect.any(Date), naturalKey: ROLE_RUN_KEY },
    ]);
    expect(h.replyContent()).toContain('Started');
  });

  // A mass run posts a message, writes Redis and books a job before it can say anything useful,
  // which is well past the three seconds Discord allows a first reply.
  test('acknowledges the interaction before it does any of the work', async () => {
    const h = harness();

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]));

    const answers = h.rest.calls.filter(
      (c) => c.path.startsWith('/interactions/') || c.path.startsWith('/webhooks/'),
    );

    expect(answers[0]?.path.startsWith('/interactions/')).toBe(true);
    expect((answers[0]?.body as { type?: number })?.type).toBe(5);
    expect((answers[0]?.body as { data?: { content?: string } })?.data?.content).toBeUndefined();

    expect(answers[1]?.path).toBe(`/webhooks/${APPLICATION_ID}/interaction-token`);
    expect((answers[1]?.body as { content?: string })?.content).toContain('Started');
  });

  test('refuses a second run while one is going, and says how to stop it', async () => {
    const h = harness();
    await h.roleRuns.put(run({ applied: 12 }));

    await h.run('role', subcommand('bots', [roleOption('role', GRANT_ROLE)]));

    expect(h.discordCalls()).toEqual([]);
    expect(h.replyContent()).toContain('/role cancel');
    expect(h.replyContent()).toContain('12 members in');
  });

  test('starts nothing when the progress message cannot be posted', async () => {
    const h = harness();
    h.rest.response = { status: 403, body: {} };

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]));

    expect(await h.roleRuns.get(GUILD)).toBeNull();
    expect(h.jobs).toEqual([]);
  });

  test('refuses /role in when the two roles are the same', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('in', [roleOption('role', GRANT_ROLE), roleOption('target_role', GRANT_ROLE)]),
    );

    expect(await h.roleRuns.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('same role');
  });

  test('refuses /role in @everyone, which would match nobody', async () => {
    const h = harness();

    await h.run(
      'role',
      subcommand('in', [roleOption('role', GRANT_ROLE), roleOption('target_role', EVERYONE_ROLE)]),
    );

    expect(await h.roleRuns.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('/role all');
  });

  // A mentionable role in the progress line would ping everyone already holding it.
  test('posts the progress message with mentions suppressed', async () => {
    const h = harness();

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]));

    const posted = h.discordCalls().find((c) => c.method === 'POST');
    expect((posted?.body as { allowed_mentions?: { parse?: string[] } })?.allowed_mentions).toEqual(
      { parse: [] },
    );
  });

  test('guards the role being handed out just like /role add does', async () => {
    const h = harness();

    await h.run('role', subcommand('humans', [roleOption('role', HIGH_ROLE)]));

    expect(await h.roleRuns.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('my own highest role');
  });

  test('says so rather than going quiet when the run store is not wired in', async () => {
    const h = harness();

    await h.run('role', subcommand('all', [roleOption('role', GRANT_ROLE)]), {
      unbindRoleDeps: true,
    });

    expect(h.replyContent()).toContain('/role add');
  });
});

describe('the mass role job', () => {
  test('grants to everybody on the page, skipping who already has it', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER), member(OTHER_MEMBER, [GRANT_ROLE]), member(BOT_MEMBER)]];

    await h.runJob();

    expect(h.discordCalls().filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect(await h.roleRuns.get(GUILD)).toBeNull();
  });

  test('records no case per member — one command must not write thousands of ledger rows', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER), member(BOT_MEMBER)]];

    await h.runJob();

    expect(h.cases()).toEqual([]);
  });

  test('bots takes only bots, humans takes only humans', async () => {
    const bots = harness();
    await bots.roleRuns.put(run({ mode: 'bots' }));
    bots.members.pages = [[member(MEMBER), member(BOT_MEMBER, [], true)]];
    await bots.runJob();

    expect(bots.discordCalls().filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(bots.discordCalls()[0]?.path).toContain(BOT_MEMBER);

    const humans = harness();
    await humans.roleRuns.put(run({ mode: 'humans' }));
    humans.members.pages = [[member(MEMBER), member(BOT_MEMBER, [], true)]];
    await humans.runJob();

    expect(humans.discordCalls().filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(humans.discordCalls()[0]?.path).toContain(MEMBER);
  });

  test('in takes only members holding the target role', async () => {
    const h = harness();
    await h.roleRuns.put(run({ mode: 'in', targetRoleId: LOW_ROLE }));
    h.members.pages = [[member(MEMBER, [LOW_ROLE]), member(BOT_MEMBER, [])]];

    await h.runJob();

    expect(h.discordCalls().filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(h.discordCalls()[0]?.path).toContain(MEMBER);
  });

  // Ranking a member costs a REST fetch, and the page already carried their roles.
  test('ranks members from the page it already read, not a second fetch each', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(BOT_MEMBER, [HIGH_ROLE])]];

    await h.runJob();

    // HIGH_ROLE outranks the bot, so the hinted roles are what the precheck judged — without the
    // hint the harness would have resolved them as roleless and granted the role instead.
    expect(h.discordCalls().filter((c) => c.method === 'PUT')).toEqual([]);

    const summary = h.discordCalls().find((c) => c.method === 'PATCH');
    expect((summary?.body as { content?: string })?.content).toContain('1 refused');
  });

  test('books the next chunk and advances the cursor while pages remain', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER)], [member(BOT_MEMBER)]];

    await h.runJob();

    const stored = await h.roleRuns.get(GUILD);
    expect(stored?.after).toBe('1');
    expect(stored?.applied).toBe(1);
    expect(h.jobs).toHaveLength(1);
  });

  test('a cancelled run stops without touching another member', async () => {
    const h = harness();
    await h.roleRuns.put(run({ cancelled: true, applied: 5 }));
    h.members.pages = [[member(MEMBER)]];

    await h.runJob();

    expect(h.discordCalls().filter((c) => c.method === 'PUT')).toEqual([]);
    expect(await h.roleRuns.get(GUILD)).toBeNull();
    expect(h.members.asked).toEqual([]);
  });

  test('gives up and says why when the member list cannot be read', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.failure = 'Server Members privileged intent is off.';

    await h.runJob();

    expect(await h.roleRuns.get(GUILD)).toBeNull();

    const edit = h.discordCalls().find((c) => c.method === 'PATCH');
    expect((edit?.body as { content?: string })?.content).toContain('privileged intent');
  });

  // The counters only persist at the end of a whole tick, so a redone page starts from the same
  // baseline and its duplicates are grants this run made, not members who already had the role.
  test('a redone chunk grants each member once and still counts it as given', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER)], [member(BOT_MEMBER)]];

    await h.runJob();
    await h.roleRuns.put(run());
    await h.runJob();

    expect(h.discordCalls().filter((c) => c.method === 'PUT')).toHaveLength(1);

    const stored = await h.roleRuns.get(GUILD);
    expect(stored?.applied).toBe(1);
    expect(stored?.skipped).toBe(0);
  });

  test('the run clears before the final edit, so a failed edit cannot wedge the guild', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER)]];
    h.rest.response = { status: 500, body: {} };

    await h.runJob();

    expect(await h.roleRuns.get(GUILD)).toBeNull();
  });
});

describe('the mass job’s guards and durability', () => {
  // A tick works for as long as a page of grants takes, and cancel lands in the middle of it.
  test('a cancel that lands mid-tick is not written back to false', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER)], [member(OTHER_MEMBER)]];

    const realList = h.members.list.bind(h.members);
    h.members.list = async (guildId, after, limit) => {
      const page = await realList(guildId, after, limit);
      const current = await h.roleRuns.get(GUILD);
      if (current) await h.roleRuns.put({ ...current, cancelled: true });
      return page;
    };

    await h.runJob();

    expect(await h.roleRuns.get(GUILD)).toBeNull();
    const summary = h.discordCalls().find((c) => c.method === 'PATCH');
    expect((summary?.body as { content?: string })?.content).toContain('Stopped');
  });

  // Every terminal edit shares one key, distinct from any progress edit, or the executor's dedupe
  // drops the only message that says the run is over.
  test('the closing edit is not deduped against the previous tick’s progress edit', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER)], [member(OTHER_MEMBER)]];

    await h.runJob();
    const stored = await h.roleRuns.get(GUILD);
    expect(stored).not.toBeNull();
    if (stored) await h.roleRuns.put({ ...stored, cancelled: true });

    await h.runJob();

    const edits = h.discordCalls().filter((c) => c.method === 'PATCH');
    expect(edits).toHaveLength(2);
    expect((edits[1]?.body as { content?: string })?.content).toContain('Stopped');
  });

  test('a transient list failure retries rather than abandoning the run', async () => {
    const h = harness();
    await h.roleRuns.put(run({ after: '3' }));
    h.members.failure = 'Discord answered 503 when I asked for the member list.';
    h.members.retryable = true;

    await h.runJob();

    const stored = await h.roleRuns.get(GUILD);
    expect(stored?.listFailures).toBe(1);
    expect(stored?.after).toBe('3');
    expect(h.jobs).toHaveLength(1);
  });

  test('a run gives up once the member list has stayed unreadable', async () => {
    const h = harness();
    await h.roleRuns.put(run({ listFailures: 4 }));
    h.members.failure = 'Discord answered 503 when I asked for the member list.';
    h.members.retryable = true;

    await h.runJob();

    expect(await h.roleRuns.get(GUILD)).toBeNull();
  });

  test('a role moved above the invoker mid-run stops the run', async () => {
    const h = harness();
    await h.roleRuns.put(run({ roleId: MOD_ROLE }));
    h.members.pages = [[member(MEMBER)]];

    await h.runJob();

    expect(h.discordCalls().filter((c) => c.method === 'PUT')).toEqual([]);
    const summary = h.discordCalls().find((c) => c.method === 'PATCH');
    expect((summary?.body as { content?: string })?.content).toContain('your own highest role');
  });

  test('skips members who outrank the moderator who asked for the run', async () => {
    const h = harness();
    await h.roleRuns.put(run());
    h.members.pages = [[member(MEMBER), member(ABOVE_BOT, [HIGH_ROLE])]];

    await h.runJob();

    const grants = h.discordCalls().filter((c) => c.method === 'PUT');
    expect(grants).toHaveLength(1);
    expect(grants[0]?.path).toContain(MEMBER);

    const summary = h.discordCalls().find((c) => c.method === 'PATCH');
    expect((summary?.body as { content?: string })?.content).toContain('1 refused');
  });
});

describe('/role cancel', () => {
  test('marks the run cancelled and says the role is not taken back', async () => {
    const h = harness();
    await h.roleRuns.put(run({ applied: 30 }));

    await h.run('role', subcommand('cancel', []));

    expect((await h.roleRuns.get(GUILD))?.cancelled).toBe(true);
    expect(h.replyContent()).toContain('30 members');
    expect(h.replyContent()).toContain('does not take it back');
  });

  test('says so when nothing is going', async () => {
    const h = harness();

    await h.run('role', subcommand('cancel', []));

    expect(h.replyContent()).toContain('No mass role run');
  });

  test('a second cancel does not undo the first', async () => {
    const h = harness();
    await h.roleRuns.put(run({ cancelled: true }));

    await h.run('role', subcommand('cancel', []));

    expect((await h.roleRuns.get(GUILD))?.cancelled).toBe(true);
    expect(h.replyContent()).toContain('already stopping');
  });
});

describe('/role acknowledges every subcommand', () => {
  test.each([
    ['add', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]],
    ['remove', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]],
    ['all', [roleOption('role', GRANT_ROLE)]],
    ['bots', [roleOption('role', GRANT_ROLE)]],
    ['humans', [roleOption('role', GRANT_ROLE)]],
    ['in', [roleOption('role', GRANT_ROLE), roleOption('target_role', LOW_ROLE)]],
    ['cancel', []],
  ] as const)('%s', async (sub, options) => {
    const h = harness();

    await h.run('role', subcommand(sub, [...options]));

    expect(h.replyContent()).not.toBeNull();
  });
});
