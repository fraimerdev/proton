import { describe, expect, test } from 'bun:test';
import {
  INTERACTION_CALLBACK_CHANNEL_MESSAGE,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  MESSAGE_FLAG_EPHEMERAL,
  Permissions,
  type RawOption,
} from '@proton/core';
import { createModerationModule } from '../src/index.ts';
import { ROLE_RUN_JOB } from '../src/role-run.ts';
import type { RoleRun, RoleRunStore } from '../src/run-store.ts';
import { slashEvent } from './drivers.ts';
import {
  ABOVE_BOT,
  APPLICATION_ID,
  BOT_PERMISSIONS,
  baseGuildState,
  CHANNEL,
  GRANT_ROLE,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  MOD_ROLE,
  MODERATOR,
  type RunOverrides,
  roleOption,
  rolesHeldBy,
  stringOption,
  subcommand,
  userOption,
} from './harness.ts';
import { callbacks, NOW, textOf } from './punish-rig.ts';

type Leaf = [label: string, name: string, options: RawOption[], says: string];

const LEAVES: Leaf[] = [
  [
    '/slowmode',
    'slowmode',
    [stringOption('duration', '30s')],
    'Members must now wait 30s between messages in this channel.',
  ],
  [
    '/lockdown add',
    'lockdown',
    subcommand('add', []),
    'Locked this channel. Run /lockdown remove when it should reopen.',
  ],
  ['/lockdown remove', 'lockdown', subcommand('remove', []), 'Unlocked this channel.'],
  [
    '/role add',
    'role',
    subcommand('add', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
    `Gave <@&${GRANT_ROLE}> to <@${MEMBER}>.`,
  ],
  [
    '/role remove',
    'role',
    subcommand('remove', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
    `Took <@&${GRANT_ROLE}> off <@${MEMBER}>.`,
  ],
];

function commandsWithoutApplication(): Partial<RunOverrides> {
  const state = baseGuildState();
  const module = createModerationModule({
    guildState: {
      get: async () => state,
      put: async () => undefined,
      patch: async () => undefined,
      delete: async () => undefined,
    },
    fetchMemberRoles: async (_guildId, userId) => rolesHeldBy(userId),
  });
  return { commands: module.commands ?? [] };
}

const NO_APPLICATION = commandsWithoutApplication();

async function run(
  name: string,
  options: RawOption[],
  overrides: Partial<RunOverrides> = {},
): Promise<Harness> {
  const h = harness({ now: NOW });
  await h.run(name, options, { idempotencyKey: 'evt-deferred', ...overrides });
  return h;
}

function flagFor(ephemeral: boolean): number | undefined {
  return ephemeral ? MESSAGE_FLAG_EPHEMERAL : undefined;
}

function initialCallbacks(h: Harness) {
  return h.requests.filter((request) => request.kind === 'interaction_reply');
}

function roleRun(overrides: Partial<RoleRun> = {}): RoleRun {
  return {
    runId: 'run-1',
    guildId: GUILD,
    roleId: GRANT_ROLE,
    mode: 'all',
    actorId: MODERATOR,
    actorRoleIds: [MOD_ROLE],
    channelId: CHANNEL,
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

interface StoreVisit {
  sent: string[];
  booked: number;
}

async function cancelling(
  seed: RoleRun | null,
  overrides: Partial<RunOverrides> = {},
): Promise<{ h: Harness; atStore: StoreVisit[] }> {
  const h = harness({ now: NOW });
  if (seed) await h.roleRuns.put(seed);

  const atStore: StoreVisit[] = [];
  const watch = () =>
    atStore.push({ sent: h.requests.map((request) => request.kind), booked: h.jobs.length });
  const roleRuns: RoleRunStore = {
    async get(guildId) {
      watch();
      return h.roleRuns.get(guildId);
    },
    async put(run) {
      watch();
      await h.roleRuns.put(run);
    },
    async clear(guildId) {
      watch();
      await h.roleRuns.clear(guildId);
    },
  };

  await h.run('role', subcommand('cancel', []), {
    idempotencyKey: 'evt-deferred',
    ...overrides,
    deps: { ...overrides.deps, roleRuns },
  });
  return { h, atStore };
}

const CANCELS = [
  ['a run going', roleRun({ applied: 30 }), 'success', 'Stopping the run giving out'],
  ['no run going', null, 'error', 'No mass role change is running in this server.'],
  ['a run already stopping', roleRun({ cancelled: true }), 'error', 'is already stopping'],
] as const;

describe('commands that call Discord before answering', () => {
  test.each(LEAVES)(
    '%s defers once, then answers as a followup',
    async (_label, name, options, says) => {
      const h = await run(name, options);

      expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
      expect(initialCallbacks(h)).toHaveLength(1);
      expect(h.followUps()).toHaveLength(1);
      expect(h.statusOf(h.followUps()[0])).toBe('success');
      expect(textOf(h.followUps()[0])).toContain(says);
      expect(h.followUps()[0]?.allowed_mentions).toEqual({ parse: [] });
    },
  );

  test.each(LEAVES)('%s acknowledges before it touches Discord', async (_label, name, options) => {
    const h = await run(name, options);
    const order = h.rest.calls.map((call) =>
      call.path.startsWith('/interactions/')
        ? 'defer'
        : call.path.startsWith('/webhooks/')
          ? 'followup'
          : 'action',
    );

    expect(order).toEqual(['defer', 'action', 'followup']);
  });

  test.each(LEAVES)('%s keys the defer and the answer apart', async (_label, name, options) => {
    const h = await run(name, options);
    const answers = h.requests.filter(
      (request) => request.kind === 'interaction_reply' || request.kind === 'interaction_followup',
    );

    expect(answers.map((request) => request.idempotencyKey)).toEqual([
      'evt-deferred:defer',
      'evt-deferred:followup:result',
    ]);
  });

  test.each(LEAVES)(
    '%s redelivered calls Discord no second time',
    async (_label, name, options) => {
      const h = harness({ now: NOW });
      await h.run(name, options, { idempotencyKey: 'evt-twice' });
      await h.run(name, options, { idempotencyKey: 'evt-twice' });

      expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
      expect(h.followUps()).toHaveLength(1);
      expect(h.discordCalls()).toHaveLength(1);
    },
  );
});

describe('/role cancel', () => {
  test.each(CANCELS)(
    'with %s it defers before it reads the run, then answers as a followup',
    async (_state, seed, tone, says) => {
      const { h, atStore } = await cancelling(seed);

      expect(h.requests[0]?.kind).toBe('interaction_reply');
      expect(h.requests[0]?.idempotencyKey).toBe('evt-deferred:defer');
      expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
      expect(initialCallbacks(h)).toHaveLength(1);
      expect(atStore.length).toBeGreaterThan(0);
      for (const visit of atStore) expect(visit.sent).toEqual(['interaction_reply']);
      expect(h.followUps()).toHaveLength(1);
      expect(h.statusOf(h.followUps()[0])).toBe(tone);
      expect(textOf(h.followUps()[0])).toContain(says);
      expect(h.followUps()[0]?.allowed_mentions).toEqual({ parse: [] });
    },
  );

  test('flags the run and books its tick only after the defer', async () => {
    const { h, atStore } = await cancelling(roleRun({ applied: 30 }));

    expect(atStore).toEqual([
      { sent: ['interaction_reply'], booked: 0 },
      { sent: ['interaction_reply'], booked: 0 },
    ]);
    expect((await h.roleRuns.get(GUILD))?.cancelled).toBe(true);
    expect(h.jobs.map((job) => job.jobId)).toEqual([ROLE_RUN_JOB]);
    expect(textOf(h.followUps()[0])).toContain('30 members');
  });

  test('redelivered, it defers and answers once', async () => {
    const h = harness({ now: NOW });
    await h.roleRuns.put(roleRun({ applied: 30 }));

    await h.run('role', subcommand('cancel', []), { idempotencyKey: 'evt-twice' });
    await h.run('role', subcommand('cancel', []), { idempotencyKey: 'evt-twice' });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.followUps()).toHaveLength(1);
    expect(h.statusOf(h.followUps()[0])).toBe('success');
  });

  test('without a run store it refuses in the one reply, reading nothing', async () => {
    const h = await run('role', subcommand('cancel', []), {
      unbindRoleDeps: true,
      deps: { applicationId: APPLICATION_ID },
    });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_CHANNEL_MESSAGE]);
    expect(h.followUps()).toEqual([]);
    expect(textOf(h.replies()[0])).toContain('no mass role change to cancel');
  });
});

const VISIBILITY = [
  [
    'no setting, Reply publicly off',
    { config: { publicReplies: false }, replyPreference: null },
    true,
  ],
  [
    'no setting, Reply publicly on',
    { config: { publicReplies: true }, replyPreference: null },
    false,
  ],
  [
    'set private under Reply publicly',
    { config: { publicReplies: true }, replyPreference: true },
    true,
  ],
  [
    'set public without Reply publicly',
    { config: { publicReplies: false }, replyPreference: false },
    false,
  ],
] as const;

describe.each(VISIBILITY)('%s', (_state, overrides, ephemeral) => {
  test.each(LEAVES)(
    '%s defers and answers with the same visibility',
    async (_label, name, options) => {
      const h = await run(name, options, overrides);

      expect(callbacks(h).map((callback) => callback.data.flags)).toEqual([flagFor(ephemeral)]);
      expect(h.followUps().map((message) => message.flags)).toEqual([flagFor(ephemeral)]);
    },
  );

  test('a refusal the options decide is the one reply, with that visibility', async () => {
    const h = await run('slowmode', [stringOption('duration', '1d')], overrides);

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_CHANNEL_MESSAGE]);
    expect(h.followUps()).toEqual([]);
    expect(h.statusOf(h.replies()[0])).toBe('error');
    expect(h.replies()[0]?.flags).toBe(flagFor(ephemeral));
  });

  test('a refusal found after the defer follows up with that visibility', async () => {
    const h = await run(
      'role',
      subcommand('add', [userOption('user', ABOVE_BOT), roleOption('role', GRANT_ROLE)]),
      overrides,
    );

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(callbacks(h)[0]?.data.flags).toBe(flagFor(ephemeral));
    expect(h.followUps().map((message) => message.flags)).toEqual([flagFor(ephemeral)]);
    expect(h.statusOf(h.followUps()[0])).toBe('error');
  });

  test('/role cancel defers and answers with the same visibility', async () => {
    const { h } = await cancelling(roleRun(), overrides);

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.followUps()).toHaveLength(1);
    expect(callbacks(h).map((callback) => callback.data.flags)).toEqual([flagFor(ephemeral)]);
    expect(h.followUps().map((message) => message.flags)).toEqual([flagFor(ephemeral)]);
  });
});

describe('refusals keep their copy', () => {
  test('options Proton checks itself are refused before any defer', async () => {
    for (const [name, options, says] of [
      ['slowmode', [stringOption('duration', 'soon')], 'soon'],
      ['slowmode', [stringOption('duration', '1d')], 'Discord caps slowmode at 6h'],
      [
        'lockdown',
        subcommand('add', [stringOption('duration', '0s')]),
        'A lockdown needs to be longer',
      ],
      ['role', subcommand('add', [userOption('user', MEMBER)]), 'Pick a role to add or remove.'],
      [
        'role',
        subcommand('remove', [roleOption('role', GRANT_ROLE)]),
        'Pick the member whose roles',
      ],
    ] as const) {
      const h = await run(name, [...options]);

      expect({ name, callbacks: h.callbackTypes() }).toEqual({
        name,
        callbacks: [INTERACTION_CALLBACK_CHANNEL_MESSAGE],
      });
      expect(h.followUps()).toEqual([]);
      expect(h.discordCalls()).toEqual([]);
      expect(textOf(h.replies()[0])).toContain(says);
    }
  });

  test('a target who outranks the invoker is refused in the followup, with the same words', async () => {
    const h = await run(
      'role',
      subcommand('add', [userOption('user', ABOVE_BOT), roleOption('role', GRANT_ROLE)]),
    );

    expect(h.discordCalls()).toEqual([]);
    expect(h.cases()).toEqual([]);
    expect(textOf(h.followUps()[0])).toContain('at or above yours');
  });

  test('a member whose roles cannot be read is refused in the followup', async () => {
    const h = await run(
      'role',
      subcommand('add', [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)]),
      { deps: { fetchMemberRoles: async () => null } },
    );

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(textOf(h.followUps()[0])).toContain('usually means they just left the server');
  });

  test('Discord refusing the action is told in the followup, naming the permission', async () => {
    const h = await run('slowmode', [stringOption('duration', '5m')], {
      appPermissions: BOT_PERMISSIONS & ~Permissions.ManageChannels,
    });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(h.discordCalls()).toEqual([]);
    expect(h.statusOf(h.followUps()[0])).toBe('error');
    expect(textOf(h.followUps()[0])).toContain('Manage Channels');
  });
});

describe('without an application id to follow up with', () => {
  test.each(LEAVES)('%s answers with one reply, as before', async (_label, name, options, says) => {
    const h = await run(name, options, NO_APPLICATION);

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_CHANNEL_MESSAGE]);
    expect(h.followUps()).toEqual([]);
    expect(h.statusOf(h.replies()[0])).toBe('success');
    expect(textOf(h.replies()[0])).toContain(says);
  });

  test.each(VISIBILITY)('%s keeps the reply’s visibility', async (_state, overrides, ephemeral) => {
    const h = await run('lockdown', subcommand('remove', []), { ...NO_APPLICATION, ...overrides });

    expect(h.replies().map((message) => message.flags)).toEqual([flagFor(ephemeral)]);
  });

  test.each(CANCELS)(
    '/role cancel with %s answers with one reply, as before',
    async (_state, seed, tone, says) => {
      const { h } = await cancelling(seed, { unbindRoleDeps: true });

      expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_CHANNEL_MESSAGE]);
      expect(h.followUps()).toEqual([]);
      expect(h.statusOf(h.replies()[0])).toBe(tone);
      expect(textOf(h.replies()[0])).toContain(says);
    },
  );

  test('the interaction’s own application id is enough to defer', async () => {
    const h = harness({ now: NOW });

    await h.command(slashEvent('lockdown', subcommand('remove', [])), NO_APPLICATION);

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    const followUp = h.rest.calls.find((call) => call.path.startsWith('/webhooks/'));
    expect(followUp?.path.startsWith(`/webhooks/${APPLICATION_ID}/`)).toBe(true);
  });
});
