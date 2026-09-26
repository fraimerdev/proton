import { describe, expect, test } from 'bun:test';
import { MESSAGE_FLAG_EPHEMERAL, type RawOption, replyControl } from '@proton/core';
import { tagCommand, tagsCommand } from '../src/commands.ts';
import { tagsDefaultConfig } from '../src/config.ts';
import type { TagsDeps } from '../src/deps.ts';
import {
  GUILD,
  type Harness,
  harness,
  MEMBER,
  type RunOverrides,
  stringOption,
} from './harness.ts';

type Outcome = [label: string, options: RawOption[], deps: TagsDeps | null, posts: boolean];

const OUTCOMES: Outcome[] = [
  ['posts a saved tag', [stringOption('name', 'rules')], null, true],
  ['refuses a tag nobody saved', [stringOption('name', 'nothing')], null, false],
  ['refuses an unusable name', [stringOption('name', 'hey!')], null, false],
  ['refuses while its storage is not wired', [stringOption('name', 'rules')], {}, false],
];

async function runTag(
  options: RawOption[],
  deps: TagsDeps | null,
  overrides: Partial<RunOverrides>,
): Promise<Harness> {
  const h = harness();
  await h.tags.create({ guildId: GUILD, name: 'rules', content: 'Be kind.', createdBy: MEMBER });
  await h.run('tag', options, {
    idempotencyKey: 'evt-tag',
    ...(deps === null ? {} : { deps }),
    ...overrides,
  });
  return h;
}

function answers(h: Harness) {
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

function flagsOf(h: Harness): number {
  return (h.bodies()[0]?.data?.flags ?? 0) & MESSAGE_FLAG_EPHEMERAL;
}

describe('tags reply policies', () => {
  test('only /tag declares one, and it follows Tags → Reply privately', () => {
    const tag = tagCommand({});

    expect(tag.reply?.toggleable).toEqual(['']);
    expect(tag.reply?.inheritsFrom).toEqual({ label: 'Tags → Reply privately', moduleId: 'tags' });
    expect(tagsCommand({}).reply).toBeUndefined();
  });

  test.each([
    [false, 'public'],
    [true, 'private'],
  ] as const)('Reply privately %p makes the default %s', (ephemeral, visibility) => {
    const tag = tagCommand({});

    expect(replyControl(tag.reply, tag.data, { ...tagsDefaultConfig, ephemeral })).toEqual({
      supported: true,
      paths: [{ path: '', default: visibility, toggleable: true }],
      inheritsFrom: { label: 'Tags → Reply privately', moduleId: 'tags' },
    });
  });
});

describe.each([
  ['off', false],
  ['on', true],
] as const)('Reply privately %s, no command setting', (_state, ephemeral) => {
  test.each(OUTCOMES)('/tag %s exactly as before', async (_label, options, deps, posts) => {
    const config = { ephemeral };
    const before = await runTag(options, deps, { config, privateReply: undefined });
    const after = await runTag(options, deps, { config, replyPreference: null });

    expect(after.requests).toEqual(before.requests);
    expect(answers(after)).toEqual([
      {
        kind: 'interaction_reply',
        key: 'evt-tag:reply',
        callbackType: undefined,
        ephemeral: posts ? ephemeral : true,
        flags: undefined,
      },
    ]);
  });
});

describe('the command’s own setting beats Reply privately', () => {
  test('set public, a tag posts in the channel although Tags replies privately', async () => {
    const h = await runTag([stringOption('name', 'rules')], null, {
      config: { ephemeral: true },
      replyPreference: false,
    });

    expect(h.replyContent()).toBe('Be kind.');
    expect(flagsOf(h)).toBe(0);
  });

  test('set private, a tag posts privately although Tags replies publicly', async () => {
    const h = await runTag([stringOption('name', 'rules')], null, {
      config: { ephemeral: false },
      replyPreference: true,
    });

    expect(h.replyContent()).toBe('Be kind.');
    expect(flagsOf(h)).toBe(MESSAGE_FLAG_EPHEMERAL);
  });

  test.each(OUTCOMES.filter(([, , , posts]) => !posts))(
    'set public, /tag still %s privately',
    async (_label, options, deps) => {
      const h = await runTag(options, deps, {
        config: { ephemeral: false },
        replyPreference: false,
      });

      expect(answers(h).map((answer) => answer.ephemeral)).toEqual([true]);
      expect(flagsOf(h)).toBe(MESSAGE_FLAG_EPHEMERAL);
    },
  );
});
