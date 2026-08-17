import { describe, expect, test } from 'bun:test';
import {
  capsRatio,
  checkAttachments,
  checkCaps,
  checkEmoji,
  checkInvites,
  checkLinks,
  checkMentions,
  checkPatterns,
  checkWalls,
  checkZalgo,
  countEmoji,
  maxCombiningStack,
} from '../src/checks.ts';
import { type AutomodConfig, automodConfigSchema } from '../src/config.ts';
import { type MessageFacts, normaliseForMatching } from '../src/message.ts';

function config(overrides: Record<string, unknown> = {}): AutomodConfig {
  return automodConfigSchema.parse({ enabled: true, ...overrides });
}

function facts(overrides: Partial<MessageFacts> = {}): MessageFacts {
  const content = overrides.content ?? '';
  return {
    messageId: '1400000000000000001',
    channelId: '500000000000000001',
    authorId: '100000000000000001',
    isBot: false,
    type: 0,
    content,
    normalised: normaliseForMatching(content),
    mentionUserIds: [],
    mentionRoleIds: [],
    mentionsEveryone: false,
    attachments: [],
    roleIds: null,
    ...overrides,
  };
}

describe('invites', () => {
  const on = config({ invitesSeverity: 'medium' });

  test('catches the common invite hosts', () => {
    for (const link of [
      'join discord.gg/abcd',
      'https://discord.com/invite/abcd',
      'discordapp.com/invite/abcd',
      'dsc.gg/abcd',
    ]) {
      expect(checkInvites(facts({ content: link }), on)).not.toBeNull();
    }
  });

  // Evasion by invisible character is the whole reason `normalised` exists.
  test('sees through zero-width characters', () => {
    expect(checkInvites(facts({ content: 'disc​ord.gg/abcd' }), on)).not.toBeNull();
  });

  test('ignores an ordinary link', () => {
    expect(checkInvites(facts({ content: 'see example.com/invite' }), on)).toBeNull();
  });

  test('a check left off never fires', () => {
    expect(checkInvites(facts({ content: 'discord.gg/abcd' }), config())).toBeNull();
  });
});

describe('links', () => {
  const on = config({ linksSeverity: 'low', linkBlockDomains: ['bad.example'] });

  test('blocks a listed domain and its subdomains', () => {
    expect(checkLinks(facts({ content: 'go to bad.example' }), on)).not.toBeNull();
    expect(checkLinks(facts({ content: 'go to login.bad.example' }), on)).not.toBeNull();
  });

  test('the allowlist wins over the blocklist', () => {
    const both = config({
      linksSeverity: 'low',
      linkBlockDomains: ['bad.example'],
      linkAllowDomains: ['safe.bad.example'],
    });

    expect(checkLinks(facts({ content: 'go to safe.bad.example' }), both)).toBeNull();
  });

  test('links inside code blocks are ignored', () => {
    expect(checkLinks(facts({ content: '```\nbad.example\n```' }), on)).toBeNull();
  });

  test('an empty blocklist checks nothing', () => {
    expect(
      checkLinks(facts({ content: 'bad.example' }), config({ linksSeverity: 'low' })),
    ).toBeNull();
  });
});

describe('mentions', () => {
  const on = config({ mentionsSeverity: 'high', mentionsLimit: 3 });

  test('counts unique mentions plus roles', () => {
    const many = facts({ mentionUserIds: ['1', '2'], mentionRoleIds: ['9'] });
    expect(checkMentions(many, on)).not.toBeNull();
  });

  test('the same person mentioned twice counts once', () => {
    const repeated = facts({ mentionUserIds: ['1', '1', '1'] });
    expect(checkMentions(repeated, on)).toBeNull();
  });

  test('@everyone fires regardless of the limit', () => {
    expect(checkMentions(facts({ mentionsEveryone: true }), on)).not.toBeNull();
  });
});

describe('attachments', () => {
  const on = config({ attachmentsSeverity: 'high' });

  test('blocks a listed extension', () => {
    const bad = facts({ attachments: [{ filename: 'setup.exe', contentType: null }] });
    expect(checkAttachments(bad, on)).not.toBeNull();
  });

  test('the last extension is the real one', () => {
    const disguised = facts({ attachments: [{ filename: 'invoice.pdf.exe', contentType: null }] });
    expect(checkAttachments(disguised, on)).not.toBeNull();
  });

  test('a blocked extension hidden before a harmless one is still caught', () => {
    const reversed = facts({ attachments: [{ filename: 'invoice.exe.pdf', contentType: null }] });
    expect(checkAttachments(reversed, on)).not.toBeNull();
  });

  test('an ordinary file passes', () => {
    const fine = facts({ attachments: [{ filename: 'holiday.png', contentType: 'image/png' }] });
    expect(checkAttachments(fine, on)).toBeNull();
  });
});

describe('patterns', () => {
  test('matches a configured pattern', () => {
    const on = config({ patternsSeverity: 'medium', regexPatterns: ['free\\s+nitro'] });
    expect(checkPatterns(facts({ content: 'FREE   NITRO here' }), on)).not.toBeNull();
  });

  test('an invalid pattern is skipped rather than throwing', () => {
    const broken = { ...config({ patternsSeverity: 'medium' }), regexPatterns: ['('] };
    expect(() => checkPatterns(facts({ content: 'anything' }), broken)).not.toThrow();
  });
});

describe('zalgo', () => {
  test('counts the longest stack on one base character', () => {
    expect(maxCombiningStack('á̂̃̄')).toBe(4);
    expect(maxCombiningStack('áb́')).toBe(1);
  });

  test('fires on a deep stack', () => {
    const on = config({ zalgoSeverity: 'low' });
    expect(checkZalgo(facts({ content: 'h́̂̃̄i' }), on)).not.toBeNull();
  });

  // A ratio test would ban these outright; a stack-height test does not.
  test('leaves ordinary accented and pointed text alone', () => {
    const on = config({ zalgoSeverity: 'low' });
    for (const text of ['café', 'שָׁלוֹם', 'नमस्ते']) {
      expect(checkZalgo(facts({ content: text }), on)).toBeNull();
    }
  });
});

describe('caps', () => {
  test('measures the ratio of cased characters only', () => {
    expect(capsRatio('HELLO THERE').ratio).toBe(100);
    expect(capsRatio('Hello There').ratio).toBeLessThan(50);
  });

  test('digits and punctuation do not count either way', () => {
    expect(capsRatio('12345 !!!').cased).toBe(0);
  });

  test('urls and mentions are stripped before measuring', () => {
    expect(capsRatio('https://EXAMPLE.COM/PATH hello').ratio).toBe(0);
  });

  test('a short shout is below the length floor', () => {
    const on = config({ capsSeverity: 'low' });
    expect(checkCaps(facts({ content: 'STOP' }), on)).toBeNull();
  });

  test('a long shout fires', () => {
    const on = config({ capsSeverity: 'low' });
    expect(checkCaps(facts({ content: 'EVERYONE STOP DOING THAT NOW' }), on)).not.toBeNull();
  });

  test('caseless scripts are exempt by construction', () => {
    const on = config({ capsSeverity: 'low' });
    expect(checkCaps(facts({ content: 'こんにちは世界こんにちは世界' }), on)).toBeNull();
  });
});

describe('emoji', () => {
  test('counts custom and unicode emoji together', () => {
    expect(countEmoji('<:a:1> <a:b:2> 🎉')).toBe(3);
  });

  // A ZWJ family is one emoji to a reader, and counting its parts would make one emoji look like
  // four.
  test('a joined sequence counts once', () => {
    expect(countEmoji('👨‍👩‍👧‍👦')).toBe(1);
  });

  test('digits are not emoji', () => {
    expect(countEmoji('1 2 3 4 5 6 7 8 9')).toBe(0);
  });

  test('fires above the limit', () => {
    const on = config({ emojiSeverity: 'low', emojiLimit: 3 });
    expect(checkEmoji(facts({ content: '🎉🎉🎉' }), on)).not.toBeNull();
  });
});

describe('walls', () => {
  test('fires on too many lines', () => {
    const on = config({ wallsSeverity: 'low', wallMaxLines: 5 });
    expect(checkWalls(facts({ content: 'a\nb\nc\nd\ne' }), on)).not.toBeNull();
  });

  test('a short message passes', () => {
    const on = config({ wallsSeverity: 'low', wallMaxLines: 5 });
    expect(checkWalls(facts({ content: 'a\nb' }), on)).toBeNull();
  });
});
