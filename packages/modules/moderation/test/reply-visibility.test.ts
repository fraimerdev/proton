import { describe, expect, test } from 'bun:test';
import {
  encodeCustomId,
  INTERACTION_CALLBACK_DEFERRED_MESSAGE,
  INTERACTION_CALLBACK_MODAL,
  leafPaths,
  MESSAGE_FLAG_EPHEMERAL,
  parseCustomId,
  type RawOption,
  replyControl,
  resolvePrivateReply,
} from '@proton/core';
import { REVIEW_ACTION, REVIEW_PRIVATE, REVIEW_PUBLIC } from '../src/commands/member.ts';
import { moderationDefaultConfig } from '../src/config.ts';
import { moderationModule } from '../src/index.ts';
import { modalEvent, pressEvent, slashEvent } from './drivers.ts';
import {
  CHANNEL,
  GRANT_ROLE,
  GUILD,
  type Harness,
  harness,
  LOW_ROLE,
  MEMBER,
  MODERATOR,
  type RunOverrides,
  roleOption,
  stringOption,
  subcommand,
  userOption,
} from './harness.ts';
import { MOD_PERMISSIONS } from './punish-kit.ts';
import {
  callbacks,
  customIds,
  lastFollowUp,
  lastModal,
  NOW,
  type PunishRig,
  punishRig,
  textOf,
} from './punish-rig.ts';

const ADOPTING = ['ban', 'kick', 'timeout', 'warn', 'role', 'slowmode', 'lockdown'];

const INVOCATIONS: Record<string, Record<string, RawOption[]>> = {
  ban: {
    add: [userOption('user', MEMBER)],
    remove: [stringOption('user_id', MEMBER)],
  },
  kick: { '': [userOption('user', MEMBER)] },
  timeout: {
    add: [userOption('user', MEMBER)],
    remove: [userOption('user', MEMBER)],
  },
  warn: {
    add: [userOption('user', MEMBER)],
    remove: [stringOption('case', 'K7f3M2q')],
  },
  role: {
    add: [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)],
    remove: [userOption('user', MEMBER), roleOption('role', GRANT_ROLE)],
    all: [roleOption('role', GRANT_ROLE)],
    bots: [roleOption('role', GRANT_ROLE)],
    humans: [roleOption('role', GRANT_ROLE)],
    in: [roleOption('role', GRANT_ROLE), roleOption('target_role', LOW_ROLE)],
    cancel: [],
  },
  slowmode: { '': [stringOption('duration', '30s')] },
  lockdown: { add: [], remove: [] },
};

type Leaf = [label: string, name: string, path: string, options: RawOption[]];

const LEAVES: Leaf[] = Object.entries(INVOCATIONS).flatMap(([name, paths]) =>
  Object.entries(paths).map(
    ([path, options]): Leaf => [`/${name}${path ? ` ${path}` : ''}`, name, path, options],
  ),
);

const ANSWERS = new Set(['interaction_reply', 'interaction_followup']);

function commandNamed(name: string) {
  const command = moderationModule.commands?.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`moderation ships no /${name}`);
  return command;
}

function invocation(path: string, options: RawOption[]): RawOption[] {
  return path === '' ? options : subcommand(path, options);
}

async function runLeaf(
  name: string,
  path: string,
  options: RawOption[],
  overrides: Partial<RunOverrides> = {},
): Promise<Harness> {
  const h = harness({ now: NOW });
  await h.run(name, invocation(path, options), { idempotencyKey: 'evt-reply', ...overrides });
  return h;
}

function trace(h: Harness) {
  return h.requests.map((request) => {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    return {
      kind: request.kind,
      key: request.idempotencyKey,
      callbackType: payload.callbackType,
      ephemeral: payload.ephemeral,
      flags: payload.flags,
    };
  });
}

function answers(h: Harness) {
  return trace(h).filter((entry) => ANSWERS.has(entry.kind));
}

function actions(h: Harness) {
  return trace(h)
    .filter((entry) => !ANSWERS.has(entry.kind))
    .map(({ kind, key }) => ({ kind, key }));
}

describe('moderation reply policies', () => {
  test('exactly the seven staff commands declare one', () => {
    const declaring = (moderationModule.commands ?? [])
      .filter((command) => command.reply)
      .map((command) => command.name);

    expect(declaring.sort()).toEqual([...ADOPTING].sort());
    expect(commandNamed('report').reply).toBeUndefined();
    for (const menu of moderationModule.contextMenus ?? []) expect('reply' in menu).toBe(false);
  });

  test.each(ADOPTING)('/%s lets admins choose every subcommand’s visibility', (name) => {
    const command = commandNamed(name);

    expect(command.reply?.toggleable).toEqual(leafPaths(command.data));
    expect(command.reply?.inheritsFrom).toEqual({
      label: 'Moderation → Reply publicly',
      moduleId: 'moderation',
    });
  });

  test.each(ADOPTING)('/%s defaults to Moderation → Reply publicly on every path', (name) => {
    const command = commandNamed(name);
    const policy = command.reply;
    if (!policy) throw new Error(`/${name} declares no reply policy`);

    for (const publicReplies of [false, true]) {
      const config = { ...moderationDefaultConfig, publicReplies };
      const control = replyControl(policy, command.data, config);

      expect(control?.supported).toBe(true);
      for (const entry of control?.paths ?? []) {
        expect(entry).toEqual({
          path: entry.path,
          default: publicReplies ? 'public' : 'private',
          toggleable: true,
        });
      }

      for (const path of leafPaths(command.data)) {
        expect(resolvePrivateReply(policy, config, path, null)).toBe(!publicReplies);
        expect(resolvePrivateReply(policy, config, path, true)).toBe(true);
        expect(resolvePrivateReply(policy, config, path, false)).toBe(false);
      }
    }
  });

  test('the table below names every leaf path of every adopting command', () => {
    for (const name of ADOPTING) {
      expect({ name, paths: Object.keys(INVOCATIONS[name] ?? {}).sort() }).toEqual({
        name,
        paths: leafPaths(commandNamed(name).data).sort(),
      });
    }
  });
});

const REPLY_PUBLICLY = [
  ['off', false],
  ['on', true],
] as const;

describe.each(REPLY_PUBLICLY)('Reply publicly %s, no command setting', (_state, publicReplies) => {
  test.each(LEAVES)('%s answers exactly as before', async (_label, name, path, options) => {
    const config = { publicReplies };
    const before = await runLeaf(name, path, options, { config, privateReply: undefined });
    const after = await runLeaf(name, path, options, { config, replyPreference: null });

    expect(trace(after)).toEqual(trace(before));
    expect(answers(after).length).toBeGreaterThan(0);
    for (const answer of answers(after)) expect(answer.ephemeral).toBe(!publicReplies);
  });
});

describe('a command’s own setting beats Reply publicly', () => {
  test.each(LEAVES)('%s set public answers in public', async (_label, name, path, options) => {
    const h = await runLeaf(name, path, options, {
      config: { publicReplies: false },
      replyPreference: false,
    });

    expect(answers(h).length).toBeGreaterThan(0);
    for (const answer of answers(h)) expect(answer.ephemeral).toBe(false);
  });

  test.each(LEAVES)('%s set private answers privately', async (_label, name, path, options) => {
    const h = await runLeaf(name, path, options, {
      config: { publicReplies: true },
      replyPreference: true,
    });

    expect(answers(h).length).toBeGreaterThan(0);
    for (const answer of answers(h)) expect(answer.ephemeral).toBe(true);
  });

  test('a deferred /ban add set public defers and follows up without the ephemeral flag', async () => {
    const h = await runLeaf('ban', 'add', [userOption('user', MEMBER)], { replyPreference: false });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(callbacks(h)[0]?.data.flags).toBeUndefined();
    expect(h.followUps().map((message) => message.flags)).toEqual([undefined]);
    expect(h.statusOf(h.followUps()[0])).toBe('success');
  });

  test('/slowmode set private under Reply publicly defers and follows up with the ephemeral flag', async () => {
    const h = await runLeaf('slowmode', '', [stringOption('duration', '30s')], {
      config: { publicReplies: true },
      replyPreference: true,
    });

    expect(h.callbackTypes()).toEqual([INTERACTION_CALLBACK_DEFERRED_MESSAGE]);
    expect(callbacks(h)[0]?.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(h.followUps().map((message) => message.flags)).toEqual([MESSAGE_FLAG_EPHEMERAL]);
  });

  test('a refusal follows the command’s setting, as it follows Reply publicly', async () => {
    const shown = await runLeaf('ban', 'remove', [stringOption('user_id', 'somebody')], {
      replyPreference: false,
    });
    const hidden = await runLeaf('ban', 'remove', [stringOption('user_id', 'somebody')], {
      config: { publicReplies: true },
      replyPreference: true,
    });

    expect(shown.statusOf(shown.replies()[0])).toBe('error');
    expect(shown.replies()[0]?.flags).toBeUndefined();
    expect(hidden.statusOf(hidden.replies()[0])).toBe('error');
    expect(hidden.replies()[0]?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
  });
});

describe('a private reply changes nothing but the reply', () => {
  test.each(LEAVES)('%s does the same work either way', async (_label, name, path, options) => {
    const shown = await runLeaf(name, path, options, { replyPreference: false });
    const hidden = await runLeaf(name, path, options, { replyPreference: true });
    const calls = (h: Harness) => h.discordCalls().map((call) => `${call.method} ${call.path}`);

    expect(actions(hidden)).toEqual(actions(shown));
    expect(calls(hidden)).toEqual(calls(shown));
    expect(hidden.cases().map((entry) => entry.kind)).toEqual(shown.cases().map((e) => e.kind));
    expect(hidden.published.map((event) => event.type)).toEqual(shown.published.map((e) => e.type));
  });

  test('a private /ban add still records the case and tells the member', async () => {
    const rig = punishRig({
      config: { publicReplies: true, punish: { notifications: { onPunish: true } } },
    });

    await rig.command(
      slashEvent('ban', subcommand('add', [userOption('user', MEMBER)]), {
        permissions: MOD_PERMISSIONS,
      }),
      { replyPreference: true },
    );

    expect(callbacks(rig.h)[0]?.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(lastFollowUp(rig.h).flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(rig.h.cases().map((entry) => entry.kind)).toEqual(['ban']);
    expect(rig.h.dms().map((dm) => dm.userId)).toEqual([MEMBER]);
  });

  test('a private /warn add still records the case and publishes the warning', async () => {
    const h = await runLeaf('warn', 'add', [userOption('user', MEMBER)], {
      config: { publicReplies: true },
      replyPreference: true,
    });

    expect(h.cases().map((entry) => entry.kind)).toEqual(['warn']);
    expect(h.published.map((event) => event.type)).toEqual(['moderation.warned']);
    for (const answer of answers(h)) expect(answer.ephemeral).toBe(true);
  });

  test('a private /role all still posts its progress message into the channel', async () => {
    const h = await runLeaf('role', 'all', [roleOption('role', GRANT_ROLE)], {
      config: { publicReplies: true },
      replyPreference: true,
    });

    expect(h.sentIn(CHANNEL)).toHaveLength(1);
    expect(h.sentIn(CHANNEL)[0]?.flags).toBeUndefined();
    expect((await h.roleRuns.get(GUILD))?.roleId).toBe(GRANT_ROLE);
    expect(h.followUps().map((message) => message.flags)).toEqual([MESSAGE_FLAG_EPHEMERAL]);
  });

  test('a private /lockdown add still locks the channel and records the case', async () => {
    const h = await runLeaf('lockdown', 'add', [], {
      config: { publicReplies: true },
      replyPreference: true,
    });

    expect(h.discordCalls().map((call) => call.method)).toEqual(['PUT']);
    expect(h.cases().map((entry) => entry.kind)).toEqual(['lockdown']);
    expect(h.followUps()[0]?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
  });
});

const RECENT = { punish: { confirmRecentCase: { enabled: true } } };

function warnAdd() {
  return slashEvent('warn', subcommand('add', [userOption('user', MEMBER)]), {
    permissions: MOD_PERMISSIONS,
  });
}

function seedRecent(rig: PunishRig, kind: 'warn' | 'ban'): void {
  rig.ledger.seed({
    caseId: 'Krecent',
    guildId: GUILD,
    kind,
    targetId: MEMBER,
    createdAt: rig.h.now() - 60_000,
  });
}

function goOf(rig: PunishRig): string {
  const [go] = customIds(lastFollowUp(rig.h));
  if (!go) throw new Error('the last follow-up carries no confirm prompt');
  return go;
}

describe('the recent-case confirmation', () => {
  test('a /warn set public says who must confirm in public, asks privately, answers in public', async () => {
    const rig = punishRig({ config: RECENT });
    seedRecent(rig, 'warn');

    await rig.command(warnAdd(), { replyPreference: false });

    expect(callbacks(rig.h)[0]?.data.flags).toBeUndefined();
    const [waiting, prompt] = rig.h.followUps();
    expect(waiting?.flags).toBeUndefined();
    expect(waiting?.content).toBe(`Waiting for <@${MODERATOR}> to confirm…`);
    expect(prompt?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(customIds(prompt)).toHaveLength(2);

    await rig.interact(pressEvent(goOf(rig), { permissions: MOD_PERMISSIONS }));

    expect(lastFollowUp(rig.h).flags).toBeUndefined();
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('a /warn set private under Reply publicly asks without the public placeholder', async () => {
    const rig = punishRig({ config: { ...RECENT, publicReplies: true } });
    seedRecent(rig, 'warn');

    await rig.command(warnAdd(), { replyPreference: true });

    expect(callbacks(rig.h)[0]?.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    const followUps = rig.h.followUps();
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(customIds(followUps[0])).toHaveLength(2);

    await rig.interact(pressEvent(goOf(rig), { permissions: MOD_PERMISSIONS }));

    expect(lastFollowUp(rig.h).flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });
});

describe('the review form', () => {
  const REVIEW = { punish: { types: { ban: { alwaysReview: true } } } };

  function banAdd() {
    return slashEvent('ban', subcommand('add', [userOption('user', MEMBER)]), {
      permissions: MOD_PERMISSIONS,
    });
  }

  async function submit(rig: PunishRig, customId: string): Promise<void> {
    await rig.interact(
      modalEvent(customId, { text: { reason: 'Raiding' } }, { permissions: MOD_PERMISSIONS }),
    );
  }

  test('a /ban set public is reviewed and answered in public although Reply publicly is off', async () => {
    const rig = punishRig({ config: REVIEW });

    await rig.command(banAdd(), { replyPreference: false });

    expect(rig.h.callbackTypes()).toEqual([INTERACTION_CALLBACK_MODAL]);
    const customId = lastModal(rig.h).custom_id ?? '';
    expect(parseCustomId(customId)?.args[1]).toBe(REVIEW_PUBLIC);

    await submit(rig, customId);

    const defer = callbacks(rig.h).at(-1);
    expect(defer?.type).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    expect(defer?.data.flags).toBeUndefined();
    expect(lastFollowUp(rig.h).flags).toBeUndefined();
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
    expect(rig.h.cases().map((entry) => entry.kind)).toEqual(['ban']);
  });

  test('a /ban set private under Reply publicly is reviewed and answered privately', async () => {
    const rig = punishRig({ config: { ...REVIEW, publicReplies: true } });

    await rig.command(banAdd(), { replyPreference: true });

    const customId = lastModal(rig.h).custom_id ?? '';
    expect(parseCustomId(customId)?.args[1]).toBe(REVIEW_PRIVATE);

    await submit(rig, customId);

    expect(callbacks(rig.h).at(-1)?.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(lastFollowUp(rig.h).flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
  });

  test('with no setting the form follows Reply publicly, as it always has', async () => {
    const rig = punishRig({ config: { ...REVIEW, publicReplies: true } });

    await rig.command(banAdd());

    const customId = lastModal(rig.h).custom_id ?? '';
    expect(parseCustomId(customId)?.args[1]).toBe(REVIEW_PUBLIC);

    await submit(rig, customId);

    expect(callbacks(rig.h).at(-1)?.data.flags).toBeUndefined();
    expect(lastFollowUp(rig.h).flags).toBeUndefined();
  });

  test('a form opened before it carried a visibility answers privately', async () => {
    const rig = punishRig({ config: { ...REVIEW, publicReplies: true } });
    await rig.command(banAdd());
    const pendingId = parseCustomId(lastModal(rig.h).custom_id)?.args[0] ?? '';
    const legacy = encodeCustomId('moderation', REVIEW_ACTION, pendingId);
    if (!legacy.ok) throw new Error('the legacy review id does not encode');

    await submit(rig, legacy.customId);

    expect(callbacks(rig.h).at(-1)?.type).toBe(INTERACTION_CALLBACK_DEFERRED_MESSAGE);
    expect(callbacks(rig.h).at(-1)?.data.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(lastFollowUp(rig.h).flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(rig.h.cases().map((entry) => entry.kind)).toEqual(['ban']);
  });

  test('a confirmation that follows the review keeps the command’s setting to the end', async () => {
    const rig = punishRig({
      config: { punish: { ...REVIEW.punish, confirmRecentCase: { enabled: true } } },
    });

    await rig.command(banAdd(), { replyPreference: false });
    seedRecent(rig, 'ban');
    await submit(rig, lastModal(rig.h).custom_id ?? '');

    const [waiting, prompt] = rig.h.followUps();
    expect(waiting?.flags).toBeUndefined();
    expect(waiting?.content).toBe(`Waiting for <@${MODERATOR}> to confirm…`);
    expect(prompt?.flags).toBe(MESSAGE_FLAG_EPHEMERAL);
    expect(textOf(prompt)).toContain('Krecent');

    await rig.interact(pressEvent(goOf(rig), { permissions: MOD_PERMISSIONS }));

    expect(lastFollowUp(rig.h).flags).toBeUndefined();
    expect(rig.h.statusOf(lastFollowUp(rig.h))).toBe('success');
    expect(rig.h.cases().map((entry) => entry.kind)).toEqual(['ban']);
  });
});
