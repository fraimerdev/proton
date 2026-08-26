import { describe, expect, test } from 'bun:test';
import { limitFor } from '@proton/core';
import {
  autocompleteEvent,
  harness,
  integerOption,
  MEMBER,
  stringOption,
  subcommand,
} from './harness.ts';

describe('/tags create', () => {
  test('saves a tag and confirms how to post it', async () => {
    const h = harness();

    await h.run(
      'tags',
      subcommand('create', [stringOption('name', 'Rules'), stringOption('content', 'Be kind.')]),
    );

    expect(await h.tags.get('900000000000000001', 'rules')).toMatchObject({
      content: 'Be kind.',
      createdBy: MEMBER,
      uses: 0,
    });
    expect(h.replyContent()).toContain('/tag rules');
  });

  test('refuses a duplicate and points at edit', async () => {
    const h = harness();

    await h.run(
      'tags',
      subcommand('create', [stringOption('name', 'rules'), stringOption('content', 'a')]),
    );
    await h.run(
      'tags',
      subcommand('create', [stringOption('name', 'rules'), stringOption('content', 'b')]),
    );

    expect((await h.tags.get('900000000000000001', 'rules'))?.content).toBe('a');
    expect(h.bodies().at(-1)?.data?.content).toContain('/tags edit');
  });

  test('refuses an unusable name before touching storage', async () => {
    const h = harness();

    await h.run(
      'tags',
      subcommand('create', [stringOption('name', 'hey!'), stringOption('content', 'a')]),
    );

    expect(h.tags.rows.size).toBe(0);
    expect(h.replyContent()).toContain('not a usable tag name');
  });

  test('refuses at the free tier limit, naming the tier, the limit and the way out', async () => {
    const h = harness();
    const cap = limitFor('free', 'tags');

    for (let index = 0; index < cap; index++) {
      await h.tags.create({
        guildId: '900000000000000001',
        name: `tag${index}`,
        content: 'x',
        createdBy: MEMBER,
      });
    }

    await h.run(
      'tags',
      subcommand('create', [stringOption('name', 'one-more'), stringOption('content', 'x')]),
    );

    expect(await h.tags.get('900000000000000001', 'one-more')).toBeNull();

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('free');
    expect(reply).toContain(String(cap));
    expect(reply).toContain('plus');
  });

  test('a plus guild gets the plus allowance', async () => {
    const h = harness();

    for (let index = 0; index < limitFor('free', 'tags'); index++) {
      await h.tags.create({
        guildId: '900000000000000001',
        name: `tag${index}`,
        content: 'x',
        createdBy: MEMBER,
      });
    }

    await h.run(
      'tags',
      subcommand('create', [stringOption('name', 'one-more'), stringOption('content', 'x')]),
      { tier: 'plus' },
    );

    expect(await h.tags.get('900000000000000001', 'one-more')).not.toBeNull();
  });
});

describe('/tag', () => {
  test('posts the stored text and counts the use', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'rules',
      content: 'Be kind.',
      createdBy: MEMBER,
    });

    await h.run('tag', [stringOption('name', 'RULES')]);

    expect(h.replyContent()).toBe('Be kind.');
    expect((await h.tags.get('900000000000000001', 'rules'))?.uses).toBe(1);
  });

  test('strips every mention by default, so a stored @everyone cannot ping', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'ping',
      content: '@everyone read this',
      createdBy: MEMBER,
    });

    await h.run('tag', [stringOption('name', 'ping')]);

    expect(h.bodies()[0]?.data?.allowed_mentions).toEqual({ parse: [] });
  });

  test('lets a guild opt back into pings', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'ping',
      content: '@everyone read this',
      createdBy: MEMBER,
    });

    await h.run('tag', [stringOption('name', 'ping')], { config: { allowMentions: true } });

    expect(h.bodies()[0]?.data?.allowed_mentions).toBeUndefined();
  });

  test('says the tag does not exist instead of doing nothing', async () => {
    const h = harness();

    await h.run('tag', [stringOption('name', 'missing')]);

    expect(h.replyContent()).toContain('no tag called **missing**');
    expect(h.replyContent()).toContain('/tags list');
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();

    await h.run('tag', [stringOption('name', 'rules')], { deps: {} });

    expect(h.replyContent()).toContain("isn't fully wired up");
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('store'))).toBe(
      true,
    );
  });
});

describe('/tags edit and delete', () => {
  test('edits an existing tag and records who changed it', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'rules',
      content: 'old',
      createdBy: 'someone-else',
    });

    await h.run(
      'tags',
      subcommand('edit', [stringOption('name', 'rules'), stringOption('content', 'new')]),
    );

    expect(await h.tags.get('900000000000000001', 'rules')).toMatchObject({
      content: 'new',
      updatedBy: MEMBER,
    });
  });

  test('editing something that is not there changes nothing and says so', async () => {
    const h = harness();

    await h.run(
      'tags',
      subcommand('edit', [stringOption('name', 'ghost'), stringOption('content', 'new')]),
    );

    expect(h.tags.rows.size).toBe(0);
    expect(h.replyContent()).toContain('nothing was changed');
  });

  test('deletes a tag', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'rules',
      content: 'x',
      createdBy: MEMBER,
    });

    await h.run('tags', subcommand('delete', [stringOption('name', 'rules')]));

    expect(h.tags.rows.size).toBe(0);
    expect(h.replyContent()).toContain('Deleted');
  });
});

describe('/tags list and info', () => {
  test('lists names a page at a time', async () => {
    const h = harness();
    for (const name of ['beta', 'alpha', 'gamma']) {
      await h.tags.create({
        guildId: '900000000000000001',
        name,
        content: 'x',
        createdBy: MEMBER,
      });
    }

    await h.run('tags', subcommand('list', [integerOption('page', 1)]));

    const reply = h.replyContent() ?? '';
    expect(reply.indexOf('alpha')).toBeLessThan(reply.indexOf('beta'));
    expect(reply).toContain('3 in total');
  });

  test('info reports the author and the use count without pinging them', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'rules',
      content: 'x',
      createdBy: MEMBER,
    });
    await h.tags.recall('900000000000000001', 'rules');

    await h.run('tags', subcommand('info', [stringOption('name', 'rules')]));

    expect(h.replyContent()).toContain(`<@${MEMBER}>`);
    expect(h.replyContent()).toContain('posted 1 time.');
    expect(h.bodies().at(-1)?.data?.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('autocomplete', () => {
  test('answers with the names that start with what was typed', async () => {
    const h = harness();
    for (const name of ['rules', 'roles', 'faq']) {
      await h.tags.create({
        guildId: '900000000000000001',
        name,
        content: 'x',
        createdBy: MEMBER,
      });
    }

    await h.autocomplete(autocompleteEvent('tag', 'R'));

    expect(h.choices().map((choice) => choice.value)).toEqual(['roles', 'rules']);
  });

  test('answers with an empty list rather than leaving the member on a spinner', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('tag', 'nothing-matches'));

    expect(h.calls()).toHaveLength(1);
    expect(h.choices()).toEqual([]);
  });

  test('ignores an autocomplete for a command another module owns', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('rank', 'r'));

    expect(h.calls()).toHaveLength(0);
  });

  test('ignores a focused option that is not the tag name', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('tags', 'r', 'content'));

    expect(h.calls()).toHaveLength(0);
  });

  test('stays quiet while the module is switched off', async () => {
    const h = harness();

    await h.autocomplete(autocompleteEvent('tag', 'r'), { config: { enabled: false } });

    expect(h.calls()).toHaveLength(0);
  });
});

describe('the case ledger', () => {
  test('recalling a tag is not a moderation case', async () => {
    const h = harness();
    await h.tags.create({
      guildId: '900000000000000001',
      name: 'rules',
      content: 'x',
      createdBy: MEMBER,
    });

    await h.run('tag', [stringOption('name', 'rules')]);

    expect(h.recorder.recorded).toHaveLength(0);
  });
});
