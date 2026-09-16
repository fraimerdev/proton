import { describe, expect, test } from 'bun:test';
import {
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import type { CreateGiveawayInput } from '../src/store.ts';
import {
  type CommandHarness,
  commandHarness,
  GUILD,
  group,
  HOST,
  MEMBER,
  STRANGER,
  stringOption,
  subcommand,
  userOption,
} from './command-harness.ts';

const HOUR = 60 * 60 * 1000;
const MANAGER_ROLE = '600000000000000001';

async function seed(h: CommandHarness, over: Partial<CreateGiveawayInput> = {}) {
  return h.store.create({
    id: 'g1',
    guildId: GUILD,
    channelId: '500000000000000000',
    messageId: '700000000000000000',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(Date.now() + 4 * HOUR),
    createdBy: HOST,
    ...over,
  } satisfies CreateGiveawayInput);
}

describe('status replies', () => {
  test('blocking a member answers with the green status embed', async () => {
    const h = commandHarness();

    await h.run(group('blacklist', 'add', [userOption('member', MEMBER)]));

    expect(h.reply()?.content).toBe('');
    expect(h.replyColour()).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyText()).toBe(
      `${STATUS_SUCCESS_EMOJI} <@${MEMBER}> can no longer enter giveaways in this server.`,
    );
  });

  test('blocking a member who is already blocked answers with the red status embed', async () => {
    const h = commandHarness();
    await h.store.addBlacklist(GUILD, {
      subjectType: 'user',
      subjectId: MEMBER,
      addedBy: HOST,
      reason: null,
    });

    await h.run(group('blacklist', 'add', [userOption('member', MEMBER)]));

    expect(h.replyColour()).toBe(STATUS_ERROR_COLOUR);
    expect(h.replyText()).toBe(
      `${STATUS_ERROR_EMOJI} <@${MEMBER}> is already blocked from giveaways in this server.`,
    );
  });

  test('cancelling a giveaway names it in green', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('cancel', [stringOption('giveaway', 'g1')]));

    expect(h.replyColour()).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyText()).toContain('**A prize** has been cancelled');
  });

  test('a giveaway id that does not exist is refused in red', async () => {
    const h = commandHarness();

    await h.run(subcommand('cancel', [stringOption('giveaway', 'nope')]));

    expect(h.replyColour()).toBe(STATUS_ERROR_COLOUR);
    expect(h.replyText()).toBe(
      `${STATUS_ERROR_EMOJI} There is no giveaway in this server with that id.`,
    );
  });

  // The manager gate is the module's only per-giveaway permission check, and it answers red like
  // every other refusal rather than falling through to the action.
  test('somebody else’s giveaway refuses the manager gate in red', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('pause', [stringOption('giveaway', 'g1')]), { userId: STRANGER });

    expect(h.replyColour()).toBe(STATUS_ERROR_COLOUR);
    expect(h.replyText()).toContain('giveaway manager');
    expect((await h.store.get(GUILD, 'g1'))?.status).toBe('running');
  });

  test('a manager role passes the gate and pauses it in green', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('pause', [stringOption('giveaway', 'g1')]), {
      userId: STRANGER,
      actorRoleIds: [MANAGER_ROLE],
      config: { managerRoleIds: [MANAGER_ROLE] },
    });

    expect(h.replyColour()).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyText()).toContain('**A prize** has been paused');
    expect((await h.store.get(GUILD, 'g1'))?.status).toBe('paused');
  });

  test('a validation failure is refused in red and nothing is created', async () => {
    const h = commandHarness();

    await h.run(
      subcommand('start', [stringOption('duration', 'soon'), stringOption('prize', 'Nitro')]),
    );

    expect(h.replyColour()).toBe(STATUS_ERROR_COLOUR);
    expect(h.replyText()).toContain('soon');
    expect(h.store.giveaways.size).toBe(0);
  });

  test('a started giveaway is announced in green and posted once', async () => {
    const h = commandHarness();

    await h.run(
      subcommand('start', [stringOption('duration', '12h'), stringOption('prize', 'Nitro')]),
    );

    expect(h.replyColour()).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyText()).toContain('**Nitro** is live');
    expect(h.requests.filter((request) => request.kind === 'send')).toHaveLength(1);
  });

  // The giveaway card is a Components V2 message, which Discord refuses to send alongside embeds.
  test('the giveaway card itself never carries a status embed', async () => {
    const h = commandHarness();

    await h.run(
      subcommand('start', [stringOption('duration', '12h'), stringOption('prize', 'Nitro')]),
    );

    const posted = h.requests.find((request) => request.kind === 'send');
    expect(posted?.payload).not.toHaveProperty('embeds');
    expect(posted?.payload).toHaveProperty('components');
  });

  test('an informational list keeps its plain styling', async () => {
    const h = commandHarness();
    await seed(h);

    await h.run(subcommand('list'));

    expect(h.replyColour()).toBeUndefined();
    expect(h.reply()?.content).toContain('A prize');
  });
});
