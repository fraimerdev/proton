import { describe, expect, test } from 'bun:test';
import { containsLink, normaliseReason, REASON_HAS_LINK, REASON_TOO_LONG } from '../src/reason.ts';

const LINKS: readonly string[] = [
  'https://example.com',
  'see HTTP://EXAMPLE.ORG/menu',
  'ftp://files.example',
  'at www.example',
  'join discord.gg/abc123',
  'discord.com/invite/abc123',
  'discordapp.com/invite/abc123',
  'dsc.gg/proton',
  'discord . gg / abc123',
  '[menu](https://example.org)',
  '[menu](example)',
  'lunch at example.com',
  'bit.ly/abc',
  'youtu.be/abc',
  'my-site.io',
  'mail bob@example.org',
  'discord​.gg/abc',
  'grabify.link/x',
  'discord\u{00AD}.gg/abc',
  'discord\u{200E}.gg/abc',
  'discord\u{202E}.gg/abc',
  'discord\u{2064}.gg/abc',
  'discord\u{180E}.gg/abc',
  'discord\u{034F}.gg/abc',
  'discord\u{3002}gg/abc',
  'discord\u{FF0E}gg/abc',
  'discord\u{FF61}gg/abc',
  '\u{FF44}\u{FF49}\u{FF53}\u{FF43}\u{FF4F}\u{FF52}\u{FF44}.\u{FF47}\u{FF47}/abc',
  'discord\\.gg/abc',
  'discord.**gg**/abc',
  'discord.g||g||/abc',
];

const NOT_LINKS: readonly string[] = [
  'lunch',
  'e.g. dinner',
  'i.e. away',
  'back at 5.30',
  'testing v1.2',
  'reading notes.txt',
  'node.js stuff',
  'a.m. meeting',
  'U.S. trip',
  'done.',
  'back in 10 min...',
  'wait...what',
  '3.14',
  'meeting (brb)',
  'Dr. Who marathon',
  '<@&123456789012345678> @everyone',
  'lunch.be back at 2',
  'At the gym.Be back soon',
  'fixing an ASP.NET bug',
  'VB.NET homework',
  'Out w/ family.Me time',
  'watching tv.me later',
  'more info.info later',
  'with Mr.Co',
  'at the store.Link up later',
  'patching 2.app',
];

describe('containsLink', () => {
  for (const text of LINKS) {
    test(`finds a link in "${text}"`, () => {
      expect(containsLink(text)).toBe(true);
    });
  }

  for (const text of NOT_LINKS) {
    test(`finds no link in "${text}"`, () => {
      expect(containsLink(text)).toBe(false);
    });
  }
});

describe('normaliseReason', () => {
  test('no reason, or only whitespace, is no reason', () => {
    expect(normaliseReason(null)).toEqual({ ok: true, reason: null });
    expect(normaliseReason(undefined)).toEqual({ ok: true, reason: null });
    expect(normaliseReason('   \n\t ')).toEqual({ ok: true, reason: null });
  });

  test('collapses newlines and runs of spaces into one line', () => {
    expect(normaliseReason('  out\n\n for   lunch  ')).toEqual({
      ok: true,
      reason: 'out for lunch',
    });
  });

  test('allows exactly 100 characters and refuses 101', () => {
    expect(normaliseReason('a'.repeat(100))).toEqual({ ok: true, reason: 'a'.repeat(100) });
    expect(normaliseReason('a'.repeat(101))).toEqual({ ok: false, humanReason: REASON_TOO_LONG });
  });

  test('counts an emoji as one character, the way Discord does', () => {
    expect(normaliseReason('😴'.repeat(100)).ok).toBe(true);
  });

  test('refuses a link or invite', () => {
    expect(normaliseReason('come to discord.gg/abc')).toEqual({
      ok: false,
      humanReason: REASON_HAS_LINK,
    });
  });

  test('keeps a mention as text; the replies are what stop it pinging', () => {
    expect(normaliseReason('ask <@123456789012345678>')).toEqual({
      ok: true,
      reason: 'ask <@123456789012345678>',
    });
  });

  test('says what is wrong in the words the member sees', () => {
    expect(REASON_TOO_LONG).toBe('Your AFK reason can be up to 100 characters.');
    expect(REASON_HAS_LINK).toBe("AFK reasons can't contain links or invites.");
  });
});
