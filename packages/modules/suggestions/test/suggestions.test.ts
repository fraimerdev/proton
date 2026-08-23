import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { SUGGESTION_CONTENT_MAX } from '../src/config.ts';
import { DOWN_EMOJI, UP_EMOJI } from '../src/embed.ts';
import { createSuggestionsModule } from '../src/index.ts';
import type { Suggestion } from '../src/store.ts';
import {
  CHANNEL,
  denyInSuggestionChannel,
  harness,
  integerOption,
  MEMBER,
  MESSAGE,
  OTHER,
  STAFF,
  SUGGESTION_CHANNEL,
  seed,
  stringOption,
  subcommand,
  THREAD,
  voteEvent,
  voteId,
} from './harness.ts';

function votesField(embed: { fields?: Array<{ name: string; value: string }> } | null): string {
  return embed?.fields?.find((entry) => entry.name === 'Votes')?.value ?? '';
}

function decisionField(
  embed: { fields?: Array<{ name: string; value: string }> } | null,
): { name: string; value: string } | undefined {
  return embed?.fields?.find((entry) => entry.name.endsWith(' by'));
}

describe('the manifest', () => {
  test('registers without the registry refusing it', () => {
    const registry = new ModuleRegistry();

    expect(() => registry.register(createSuggestionsModule())).not.toThrow();
    expect(registry.get('suggestions')?.commands?.map((c) => c.name)).toEqual([
      'suggest',
      'suggestion',
    ]);
  });

  test('the invite it asks for covers posting embeds and opening the thread it offers', () => {
    const registry = new ModuleRegistry();
    registry.register(createSuggestionsModule());

    const invite = registry.invitePermissions();

    for (const bit of [
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.EmbedLinks,
      Permissions.CreatePublicThreads,
    ]) {
      expect((invite & bit) === bit).toBe(true);
    }
  });
});

describe('/suggest', () => {
  test('refuses when no suggestion channel is set and says who has to set one', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], {
      config: { channelId: undefined },
    });

    expect(h.store.rows.size).toBe(0);
    expect(h.sendBodies()).toHaveLength(0);

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('has not picked a suggestion channel');
    expect(reply).toContain('admin');
  });

  test('posts an embed with two vote buttons and confirms the number', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    expect(h.sendBodies()).toHaveLength(1);
    expect(h.postedEmbed()?.title).toBe('Suggestion #1');
    expect(h.postedEmbed()?.description).toContain('Add a bot-commands channel.');
    expect(h.buttons()).toHaveLength(2);

    const said = h.followUpContent() ?? '';
    expect(said).toContain('suggestion #1');
    expect(said).toContain(`<#${SUGGESTION_CHANNEL}>`);
  });

  test('acknowledges the interaction before it touches the database', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    expect(h.interactionBodies()[0]?.type).toBe(5);
    expect(h.calls()[0]?.path).toContain('/callback');
  });

  test('records the message it posted, so votes can edit it later', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    expect([...h.store.rows.values()][0]).toMatchObject({
      messageId: MESSAGE,
      authorId: MEMBER,
      status: 'open',
      number: 1,
    });
  });

  test('numbers suggestions in the order they arrive', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'First.')]);
    await h.run('suggest', [stringOption('text', 'Second.')]);

    expect([...h.store.rows.values()].map((row) => row.number).sort()).toEqual([1, 2]);
    expect(h.followUpContent()).toContain('suggestion #2');
  });

  test('a redelivered command posts once and leaves one row, not two numbers', async () => {
    const h = harness();
    const idempotencyKey = 'interaction.command:600000000000000001';

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], {
      idempotencyKey,
    });
    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], {
      idempotencyKey,
    });

    expect(h.sendBodies()).toHaveLength(1);
    expect(h.store.rows.size).toBe(1);
    expect([...h.store.rows.values()][0]?.number).toBe(1);
  });

  test('hides the author when the server asked for anonymous suggestions', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], {
      config: { anonymous: true },
    });

    expect(h.postedEmbed()?.description).not.toContain(MEMBER);
    expect(h.postedEmbed()?.description).toContain('anonymously');
    expect([...h.store.rows.values()][0]?.authorId).toBe(MEMBER);
  });

  test('refuses an empty suggestion before writing anything', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', '   ')]);

    expect(h.store.rows.size).toBe(0);
    expect(h.replyContent()).toContain('empty');
  });

  test('refuses an overlong suggestion and names the cap', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'x'.repeat(SUGGESTION_CONTENT_MAX + 1))]);

    expect(h.store.rows.size).toBe(0);
    expect(h.replyContent()).toContain(String(SUGGESTION_CONTENT_MAX));
  });

  test('names SendMessages when the bot cannot post in the suggestion channel', async () => {
    const h = harness({
      suggestionChannelOverwrites: denyInSuggestionChannel(Permissions.SendMessages),
    });

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    const said = h.followUpContent() ?? '';
    expect(said).toContain('SendMessages');
    expect(said).toContain(SUGGESTION_CHANNEL);
  });

  test('leaves no row behind when the post could not be made', async () => {
    const h = harness({
      suggestionChannelOverwrites: denyInSuggestionChannel(Permissions.SendMessages),
    });

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    expect(h.store.rows.size).toBe(0);
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], { deps: {} });

    expect(h.replyContent()).toContain("isn't fully set up");
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('store'))).toBe(
      true,
    );
  });
});

describe('/suggest and its discussion thread', () => {
  test('opens a public thread and remembers it when the server asked for one', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], {
      config: { createThread: true },
    });

    expect(h.threadBodies()).toHaveLength(1);
    expect(h.threadBodies()[0]).toMatchObject({
      type: 11,
      name: 'Suggestion #1 — Add a bot-commands channel.',
    });
    expect([...h.store.rows.values()][0]?.threadId).toBe(THREAD);
    expect(h.followUpContent()).toContain(`<#${THREAD}>`);
  });

  test('opens no thread when the server did not ask for one', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    expect(h.threadBodies()).toHaveLength(0);
  });

  test('still posts the suggestion and names the missing permission when the thread fails', async () => {
    const h = harness({
      suggestionChannelOverwrites: denyInSuggestionChannel(Permissions.CreatePublicThreads),
    });

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')], {
      config: { createThread: true },
    });

    expect(h.sendBodies()).toHaveLength(1);
    expect(h.store.rows.size).toBe(1);

    const said = h.followUpContent() ?? '';
    expect(said).toContain('suggestion #1');
    expect(said).toContain('CreatePublicThreads');
  });
});

describe('the vote buttons', () => {
  test('acknowledges the press before it touches the database', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')));

    expect(h.interactionBodies()[0]?.type).toBe(5);
  });

  test('counts an upvote and repaints the post with the new totals', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')));

    expect(await h.store.tally(suggestion.id)).toEqual({ up: 1, down: 0 });
    expect(votesField(h.editedEmbed())).toContain(`${UP_EMOJI} **1**`);
    expect(h.followUpContent()).toContain('Counted your');
  });

  test('voting up then down leaves one vote and recounts rather than adding up', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')));
    await h.press(voteEvent(voteId(suggestion.id, 'down')));

    expect(h.store.votes.get(suggestion.id)?.size).toBe(1);
    expect(await h.store.tally(suggestion.id)).toEqual({ up: 0, down: 1 });

    const votes = votesField(h.editedEmbed());
    expect(votes).toContain(`${UP_EMOJI} **0**`);
    expect(votes).toContain(`${DOWN_EMOJI} **1**`);
    expect(votes).toContain('**-1**');
  });

  test('two members each hold their own vote', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')));
    await h.press(voteEvent(voteId(suggestion.id, 'up'), { userId: OTHER }));

    expect(await h.store.tally(suggestion.id)).toEqual({ up: 2, down: 0 });
  });

  test('pressing the same button twice reads as unchanged, not as an error', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')));
    await h.press(voteEvent(voteId(suggestion.id, 'up')));

    expect(await h.store.tally(suggestion.id)).toEqual({ up: 1, down: 0 });

    const said = h.followUpContent() ?? '';
    expect(said).toContain('already counted');
    expect(said).toContain('nothing changed');
  });

  test('refuses the author’s own vote by name when the server disallows it', async () => {
    const h = harness();
    const suggestion = await seed(h, { authorId: MEMBER });

    await h.press(voteEvent(voteId(suggestion.id, 'up')), {
      config: { allowSelfVote: false },
    });

    expect(h.store.votes.get(suggestion.id)).toBeUndefined();

    const said = h.followUpContent() ?? '';
    expect(said).toContain('is your own');
    expect(said).toContain('Let members vote on their own suggestion');
  });

  test('still lets everyone else vote when self-votes are off', async () => {
    const h = harness();
    const suggestion = await seed(h, { authorId: MEMBER });

    await h.press(voteEvent(voteId(suggestion.id, 'up'), { userId: OTHER }), {
      config: { allowSelfVote: false },
    });

    expect(await h.store.tally(suggestion.id)).toEqual({ up: 1, down: 0 });
  });

  test('lets the author vote on their own suggestion by default', async () => {
    const h = harness();
    const suggestion = await seed(h, { authorId: MEMBER });

    await h.press(voteEvent(voteId(suggestion.id, 'up')));

    expect(await h.store.tally(suggestion.id)).toEqual({ up: 1, down: 0 });
  });

  test('refuses a vote on a decided suggestion and says which decision closed it', async () => {
    const h = harness();
    const suggestion = await seed(h, { status: 'denied', decidedBy: STAFF });

    await h.press(voteEvent(voteId(suggestion.id, 'up')));

    expect(h.store.votes.get(suggestion.id)).toBeUndefined();
    expect(h.followUpContent()).toContain('Denied');
    expect(h.followUpContent()).toContain('voting on it is closed');
  });

  test('tells the member when the suggestion is gone instead of failing silently', async () => {
    const h = harness();

    await h.press(voteEvent(voteId('nothing-here', 'up')));

    expect(h.followUpContent()).toContain('no longer on record');
  });

  test('ignores a button another module owns', async () => {
    const h = harness();

    await h.press(voteEvent('proton:rolemenu:colours:red'));

    expect(h.calls()).toHaveLength(0);
  });

  test('says so instead of counting a vote while the module is switched off', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')), { config: { enabled: false } });

    expect(h.store.votes.get(suggestion.id)).toBeUndefined();
    expect(h.replyContent()).toContain('switched off');
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')), { deps: {} });

    expect(h.replyContent()).toContain("isn't fully set up");
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('store'))).toBe(
      true,
    );
  });

  test('counts the vote and says the post could not be repainted when there is no message id', async () => {
    const h = harness();
    const suggestion = await seed(h, { messageId: null });

    await h.press(voteEvent(voteId(suggestion.id, 'up')));

    expect(await h.store.tally(suggestion.id)).toEqual({ up: 1, down: 0 });
    expect(h.editBodies()).toHaveLength(0);
    expect(h.followUpContent()).toContain('never recorded which message it is');
  });
});

describe('/suggestion accept, deny and implement', () => {
  async function decided(status: 'accept' | 'deny' | 'implement', reason?: string) {
    const h = harness();
    const suggestion = await seed(h);

    await h.run(
      'suggestion',
      subcommand(status, [
        integerOption('number', 1),
        ...(reason === undefined ? [] : [stringOption('reason', reason)]),
      ]),
      { userId: STAFF },
    );

    return { h, suggestion };
  }

  test('accepting edits the original post and records who decided it', async () => {
    const { h, suggestion } = await decided('accept', 'Doing it this week.');

    expect(await h.store.get(suggestion.guildId, suggestion.id)).toMatchObject({
      status: 'accepted',
      decidedBy: STAFF,
      decisionReason: 'Doing it this week.',
    });

    expect(h.editBodies()).toHaveLength(1);
    expect(h.editedEmbed()?.title).toBe('Suggestion #1');
    expect(decisionField(h.editedEmbed())?.name).toBe('Accepted by');
    expect(decisionField(h.editedEmbed())?.value).toContain(STAFF);
    expect(decisionField(h.editedEmbed())?.value).toContain('Doing it this week.');
  });

  test('the edit goes to the channel the suggestion was posted in', async () => {
    const { h } = await decided('accept');

    expect(h.calls().find((call) => call.method === 'PATCH')?.path).toContain(SUGGESTION_CHANNEL);
  });

  test('a decision closes voting by greying the buttons out', async () => {
    const { h } = await decided('deny', 'Not this year.');

    expect(h.buttons().every((button) => button.disabled === true)).toBe(true);
  });

  test('denying and implementing record their own status', async () => {
    for (const [action, status] of [
      ['deny', 'denied'],
      ['implement', 'implemented'],
    ] as const) {
      const { h, suggestion } = await decided(action);

      expect((await h.store.get(suggestion.guildId, suggestion.id))?.status).toBe(status);
    }
  });

  test('a decision with no reason still edits the post and names the decider', async () => {
    const { h } = await decided('implement');

    expect(decisionField(h.editedEmbed())?.value).toContain(STAFF);
  });

  test('re-deciding replaces the verdict rather than stacking a second one', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.run(
      'suggestion',
      subcommand('accept', [integerOption('number', 1), stringOption('reason', 'Sounds good.')]),
      { userId: STAFF },
    );

    await h.run(
      'suggestion',
      subcommand('deny', [
        integerOption('number', 1),
        stringOption('reason', 'On reflection, no.'),
      ]),
      { userId: OTHER },
    );

    expect((await h.store.get(suggestion.guildId, suggestion.id))?.decisionReason).toBe(
      'On reflection, no.',
    );

    const embed = h.editedEmbed();
    expect(embed?.fields?.filter((entry) => entry.name.endsWith(' by'))).toHaveLength(1);
    expect(decisionField(embed)?.name).toBe('Denied by');
    expect(JSON.stringify(embed)).not.toContain('Sounds good.');
    expect(h.followUpContent()).toContain('It was **Accepted** before');
  });

  test('deciding a suggestion the way it already stands changes nothing and says so', async () => {
    const h = harness();
    const suggestion = await seed(h, { status: 'accepted', decidedBy: STAFF });

    await h.run('suggestion', subcommand('accept', [integerOption('number', 1)]), {
      userId: OTHER,
    });

    expect((await h.store.get(suggestion.guildId, suggestion.id))?.decidedBy).toBe(STAFF);
    expect(h.editBodies()).toHaveLength(0);
    expect(h.followUpContent()).toContain('already **Accepted**');
  });

  test('refuses a number that does not exist and says the number is the one on the post', async () => {
    const h = harness();
    await seed(h);

    await h.run('suggestion', subcommand('accept', [integerOption('number', 99)]), {
      userId: STAFF,
    });

    expect(h.editBodies()).toHaveLength(0);
    expect(h.followUpContent()).toContain('no **suggestion #99**');
  });

  test('a suggestion whose message was never recorded is still decided, and says the post is stale', async () => {
    const h = harness();
    const suggestion = await seed(h, { messageId: null });

    await h.run('suggestion', subcommand('accept', [integerOption('number', 1)]), {
      userId: STAFF,
    });

    expect((await h.store.get(suggestion.guildId, suggestion.id))?.status).toBe('accepted');
    expect(h.editBodies()).toHaveLength(0);
    expect(h.followUpContent()).toContain('still shows the old status');
  });

  test('the decision keeps the votes already cast on the post', async () => {
    const h = harness();
    const suggestion = await seed(h);

    await h.press(voteEvent(voteId(suggestion.id, 'up')));
    await h.press(voteEvent(voteId(suggestion.id, 'up'), { userId: OTHER }));

    await h.run('suggestion', subcommand('accept', [integerOption('number', 1)]), {
      userId: STAFF,
    });

    expect(votesField(h.editedEmbed())).toContain(`${UP_EMOJI} **2**`);
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();

    await h.run('suggestion', subcommand('accept', [integerOption('number', 1)]), { deps: {} });

    expect(h.replyContent()).toContain("isn't fully set up");
  });
});

describe('the case ledger', () => {
  test('posting, voting and deciding are not moderation cases', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    const suggestion = [...h.store.rows.values()][0] as Suggestion;
    await h.press(voteEvent(voteId(suggestion.id, 'up')));
    await h.run('suggestion', subcommand('accept', [integerOption('number', 1)]), {
      userId: STAFF,
    });

    expect(h.recorder.recorded).toHaveLength(0);
  });
});

describe('what a suggestion may not ping', () => {
  test('a suggestion body cannot ping the server', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', '@everyone please read this')]);

    expect(h.sendBodies()[0]?.allowed_mentions).toEqual({ parse: [] });
  });

  test('the command channel is not where the suggestion lands', async () => {
    const h = harness();

    await h.run('suggest', [stringOption('text', 'Add a bot-commands channel.')]);

    expect(h.calls().some((call) => call.path.includes(CHANNEL))).toBe(false);
  });
});
