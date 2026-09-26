import { describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { punish } from '../src/punish/pipeline.ts';
import { CASE_MESSAGE_RETENTION_MS } from '../src/punish/snapshot.ts';
import {
  CHANNEL,
  discordError,
  GRANT_ROLE,
  GUILD,
  LOW_ROLE,
  MEMBER,
  MESSAGE,
  MODERATOR,
  OWNER,
} from './harness.ts';
import { callsTo, executed, kit, moderator, request } from './punish-kit.ts';

const ON_TIMEOUT = {
  punish: {
    types: {
      timeout: {
        actions: { addRoleIds: [GRANT_ROLE], removeRoleIds: [LOW_ROLE], disconnectVoice: true },
      },
    },
  },
};

const PROOF = {
  channelId: CHANNEL,
  messageId: MESSAGE,
  authorId: MEMBER,
  content: 'join my server',
  createdAt: 1_700_000_000_000,
  attachments: [
    {
      id: '1500000000000000001',
      filename: 'proof.png',
      contentType: 'image/png',
      size: 1024,
      url: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
      proxyUrl: null,
      width: 10,
      height: 10,
      ephemeral: false,
      expiresAt: 1_800_000_000_000,
    },
  ],
  url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
};

const OWNER_ACTOR = moderator({ id: OWNER, roleIds: [] });

describe('actions on punish', () => {
  test('each extra has its own key, roles are recorded and the disconnect is not', async () => {
    const k = kit({ config: ON_TIMEOUT });

    const outcome = executed(await k.run(request('timeout')));

    expect(k.h.keysUsed()).toEqual([
      'evt-1:action',
      'evt-1:extra:0',
      'evt-1:extra:1',
      'evt-1:extra:2',
    ]);
    expect(callsTo(k.h, /^(PUT|DELETE|PATCH) \/guilds\//)).toEqual([
      `PATCH /guilds/${GUILD}/members/${MEMBER}`,
      `PUT /guilds/${GUILD}/members/${MEMBER}/roles/${GRANT_ROLE}`,
      `DELETE /guilds/${GUILD}/members/${MEMBER}/roles/${LOW_ROLE}`,
      `PATCH /guilds/${GUILD}/members/${MEMBER}`,
    ]);
    expect(k.h.rest.calls.at(-1)?.body).toEqual({ channel_id: null });
    expect(k.h.cases().map((entry) => entry.kind)).toEqual(['timeout', 'add_role', 'remove_role']);
    expect(outcome.extras.map((extra) => [extra.step, extra.status])).toEqual([
      ['add_role', 'done'],
      ['remove_role', 'done'],
      ['disconnect', 'done'],
    ]);
  });

  test('a member who is not in voice is nothing to do, not a failure', async () => {
    const k = kit({ config: ON_TIMEOUT });
    k.h.rest.respond(
      (call) =>
        call.method === 'PATCH' && (call.body as { channel_id?: unknown }).channel_id === null,
      discordError(400, 40032, 'Target user is not connected to voice.'),
    );

    const outcome = executed(await k.run(request('timeout')));

    expect(outcome.extras.at(-1)).toEqual({
      step: 'disconnect',
      status: 'skipped',
      message: 'Not in voice, so nothing to do.',
    });
    expect(outcome.summary).not.toContain('voice');
  });

  test('a failing extra is reported but never undoes the punishment', async () => {
    const k = kit({ config: ON_TIMEOUT });
    k.h.rest.respond(
      /^PUT \/guilds\/\d+\/members\/\d+\/roles\//,
      discordError(403, 50013, 'Missing Permissions'),
    );

    const outcome = executed(await k.run(request('timeout')));

    expect(outcome.extras[0]).toMatchObject({
      step: 'add_role',
      status: 'failed',
      roleId: GRANT_ROLE,
    });
    expect(outcome.summary).toContain(`Couldn't add <@&${GRANT_ROLE}>`);
    expect(outcome.caseId).not.toBeNull();
  });

  test('warnings run their own actions', async () => {
    const k = kit({
      config: { punish: { types: { warn: { actions: { addRoleIds: [GRANT_ROLE] } } } } },
    });

    const outcome = executed(await k.run(request('warn')));

    expect(outcome.extras).toEqual([
      { step: 'add_role', roleId: GRANT_ROLE, status: 'done', message: `Added <@&${GRANT_ROLE}>.` },
    ]);
  });
});

describe('the proof message', () => {
  test('is deleted after the punishment when the type says so, and never recorded', async () => {
    const k = kit({ config: { punish: { types: { warn: { deleteProof: true } } } } });

    const outcome = executed(
      await k.run(
        request('warn', { actor: OWNER_ACTOR, origin: { type: 'message' }, proof: PROOF }),
      ),
    );

    expect(outcome.proofDeleted).toBe(true);
    expect(k.h.deletes()).toEqual([{ channelId: CHANNEL, messageId: MESSAGE }]);
    expect(k.h.keysUsed()).toEqual(['evt-1:action', 'evt-1:proof']);
    expect(k.h.cases().map((entry) => entry.kind)).toEqual(['warn']);
  });

  test('a message that is already gone counts as deleted', async () => {
    const k = kit();
    k.h.rest.respond(/^DELETE \/channels\//, discordError(404, 10008, 'Unknown Message'));

    const outcome = executed(
      await k.run(
        request('warn', {
          actor: OWNER_ACTOR,
          origin: { type: 'message' },
          proof: PROOF,
          deleteProof: true,
        }),
      ),
    );

    expect(outcome.proofDeleted).toBe(true);
    expect(outcome.extras).toContainEqual({
      step: 'delete_proof',
      status: 'skipped',
      message: 'The message was already gone.',
    });
  });

  test('a refused deletion is reported and the punishment stands', async () => {
    const k = kit();
    k.h.rest.respond(/^DELETE \/channels\//, discordError(403, 50013, 'Missing Permissions'));

    const outcome = executed(
      await k.run(
        request('warn', {
          actor: OWNER_ACTOR,
          origin: { type: 'message' },
          proof: PROOF,
          deleteProof: true,
        }),
      ),
    );

    expect(outcome.proofDeleted).toBe(false);
    expect(outcome.summary).toContain("Couldn't delete the message");
  });
});

describe('case message history', () => {
  async function buffered(k: ReturnType<typeof kit>): Promise<void> {
    const base = { channelId: CHANNEL, attachments: [], deletedAt: null };
    await k.history.record(GUILD, {
      ...base,
      messageId: '1400000000000000002',
      authorId: MEMBER,
      content: 'one',
      createdAt: 1,
    });
    await k.history.record(GUILD, {
      ...base,
      messageId: MESSAGE,
      authorId: MEMBER,
      content: 'join my server',
      createdAt: 2,
    });
    await k.history.record(GUILD, {
      ...base,
      messageId: '1400000000000000003',
      authorId: MODERATOR,
      content: 'hi',
      createdAt: 3,
    });
  }

  test('snapshots the proof and the member’s buffered messages onto the case for 30 days', async () => {
    const k = kit({ config: { punish: { messageHistory: true } } });
    await buffered(k);

    const outcome = executed(
      await k.run(
        request('ban', { actor: OWNER_ACTOR, origin: { type: 'message' }, proof: PROOF }),
      ),
    );

    const rows = await k.caseMessages.forCase(GUILD, outcome.caseId ?? '');
    expect(rows.map((row) => [row.messageId, row.proof])).toEqual([
      ['1400000000000000002', false],
      [MESSAGE, true],
    ]);
    expect(rows.every((row) => row.expiresAt === k.h.now() + CASE_MESSAGE_RETENTION_MS)).toBe(true);
    expect(rows.find((row) => row.proof)?.attachments[0]).toEqual({
      id: '1500000000000000001',
      filename: 'proof.png',
      contentType: 'image/png',
      size: 1024,
      url: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
      expiresAt: 1_800_000_000_000,
    });
    expect(outcome.extras).toContainEqual({
      step: 'history',
      status: 'done',
      message: 'Saved 2 recent messages to the case.',
    });
  });

  test('nothing is kept while case message history is off', async () => {
    const k = kit();
    await buffered(k);

    const outcome = executed(await k.run(request('ban')));

    expect(k.caseMessages.rows).toHaveLength(0);
    expect(outcome.extras).toEqual([]);
  });

  test('the message punished from is kept as proof for 30 days even with history off', async () => {
    const k = kit();
    await buffered(k);

    const outcome = executed(
      await k.run(
        request('warn', {
          actor: OWNER_ACTOR,
          origin: { type: 'message' },
          proof: PROOF,
          deleteProof: true,
        }),
      ),
    );

    expect(outcome.proofDeleted).toBe(true);
    const rows = await k.caseMessages.forCase(GUILD, outcome.caseId ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageId: MESSAGE,
      proof: true,
      content: PROOF.content,
      expiresAt: k.h.now() + CASE_MESSAGE_RETENTION_MS,
    });
    expect(outcome.extras).toContainEqual({
      step: 'history',
      status: 'done',
      message: 'Kept the message on the case.',
    });
  });

  test('a failed save of the proof is logged without the message content', async () => {
    const k = kit();
    const failing = {
      save: async () => {
        const cause = Object.assign(new Error('connection reset'), { code: '08006' });
        throw new DrizzleQueryError('insert into moderation_case_messages', [PROOF.content], cause);
      },
      forCase: async () => [],
      purgeExpired: async () => 0,
    };

    const outcome = executed(
      await punish(
        k.ctx(),
        { ...k.deps, caseMessages: failing },
        request('warn', { actor: OWNER_ACTOR, origin: { type: 'message' }, proof: PROOF }),
      ),
    );

    expect(outcome.summary).toContain("Couldn't keep the message on the case.");
    const logged = k.h.logs.find((log) => log.message.includes('could not snapshot'));
    expect(logged?.message).toContain('database query failed (08006)');
    expect(k.h.logs.some((log) => log.message.includes(PROOF.content))).toBe(false);
  });

  test('a missing buffer is reported but the ban stands', async () => {
    const k = kit({ config: { punish: { messageHistory: true } } });
    const { history: _unbound, ...deps } = k.deps;

    const outcome = executed(await punish(k.ctx(), deps, request('ban')));

    expect(outcome.extras).toEqual([
      expect.objectContaining({ step: 'history', status: 'failed' }),
    ]);
  });
});
