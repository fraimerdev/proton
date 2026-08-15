import { describe, expect, test } from 'bun:test';
import {
  domainCandidates,
  extractHosts,
  MAX_HOSTS_PER_MESSAGE,
  MAX_SUFFIXES_PER_HOST,
  normaliseDomain,
} from '../src/domains.ts';

describe('normaliseDomain', () => {
  test('reduces the shapes a feed actually ships to one comparable domain', () => {
    expect(normaliseDomain('EVIL.COM')).toBe('evil.com');
    expect(normaliseDomain('  evil.com  ')).toBe('evil.com');
    expect(normaliseDomain('evil.com.')).toBe('evil.com');
    expect(normaliseDomain('*.evil.com')).toBe('evil.com');
    expect(normaliseDomain('.evil.com')).toBe('evil.com');
    expect(normaliseDomain('http://evil.com/login?a=1#x')).toBe('evil.com');
    expect(normaliseDomain('https://user:pass@evil.com:8443/path')).toBe('evil.com');
  });

  test('rejects everything that is not a domain, rather than caching it as one', () => {
    expect(normaliseDomain('')).toBeNull();
    expect(normaliseDomain('   ')).toBeNull();
    expect(normaliseDomain('# comment')).toBeNull();
    expect(normaliseDomain('localhost')).toBeNull();
    expect(normaliseDomain('192.168.0.1')).toBeNull();
    expect(normaliseDomain('[2001:db8::1]')).toBeNull();
    expect(normaliseDomain(`${'a'.repeat(250)}.com`)).toBeNull();
  });

  test('rejects a bare TLD — a feed shipping one would block the whole internet', () => {
    expect(normaliseDomain('com')).toBeNull();
    expect(normaliseDomain('ru')).toBeNull();
  });
});

describe('extractHosts', () => {
  test('finds hosts with and without a scheme, and inside Discord markdown', () => {
    expect(extractHosts('grab it at https://free-nitro.gift/claim now')).toEqual([
      'free-nitro.gift',
    ]);
    expect(extractHosts('go to free-nitro.gift for a free one')).toEqual(['free-nitro.gift']);
    expect(extractHosts('[click here](https://free-nitro.gift/claim)')).toEqual([
      'free-nitro.gift',
    ]);
  });

  test('is not fooled by a legitimate host in the userinfo position', () => {
    // https://steamcommunity.com@evil.com/ resolves to evil.com. Both are
    // extracted, so the blocked one is still checked.
    expect(extractHosts('https://steamcommunity.com@evil.com/gift')).toEqual([
      'steamcommunity.com',
      'evil.com',
    ]);
  });

  test('drops trailing punctuation instead of folding it into the host', () => {
    expect(extractHosts('see evil.com.')).toEqual(['evil.com']);
    expect(extractHosts('(evil.com)')).toEqual(['evil.com']);
  });

  test('deduplicates and caps how many hosts one message can contribute', () => {
    expect(extractHosts('a.com a.com a.com')).toEqual(['a.com']);

    const many = Array.from({ length: 200 }, (_, index) => `host${index}.com`).join(' ');
    expect(extractHosts(many)).toHaveLength(MAX_HOSTS_PER_MESSAGE);
  });

  test('finds nothing in ordinary prose that has no host in it', () => {
    expect(extractHosts('hello everyone, how is the weekend going')).toEqual([]);
  });
});

describe('domainCandidates', () => {
  test('offers every parent domain, so listing a domain covers its subdomains', () => {
    expect(domainCandidates('login.secure.evil.com')).toEqual([
      'login.secure.evil.com',
      'secure.evil.com',
      'evil.com',
    ]);
  });

  test('never offers the bare TLD', () => {
    expect(domainCandidates('evil.com')).toEqual(['evil.com']);
    expect(domainCandidates('com')).toEqual([]);
  });

  test('bounds a pathologically deep host while keeping the exact host and the tail', () => {
    const deep = `${Array.from({ length: 40 }, (_, i) => `l${i}`).join('.')}.evil.com`;
    const candidates = domainCandidates(deep);

    expect(candidates).toHaveLength(MAX_SUFFIXES_PER_HOST);
    expect(candidates[0]).toBe(deep);
    expect(candidates.at(-1)).toBe('evil.com');
  });
});

/**
 * The false-positive suite.
 *
 * Every case here is one that a `content.includes(domain)` or an `endsWith`
 * implementation gets wrong, which is why they are written as candidate-set
 * assertions rather than left to the integration test: this is the property the
 * module is judged on, and it has to fail loudly at the unit level.
 */
describe('label-boundary matching', () => {
  const blocked = 'steamcommunity-gift.ru';

  function matches(host: string): boolean {
    return domainCandidates(host).includes(blocked);
  }

  test('matches the listed domain and anything under it', () => {
    expect(matches('steamcommunity-gift.ru')).toBe(true);
    expect(matches('www.steamcommunity-gift.ru')).toBe(true);
    expect(matches('login.trade.steamcommunity-gift.ru')).toBe(true);
  });

  test('does not match a different TLD on the same second-level name', () => {
    expect(matches('steamcommunity-gift.com')).toBe(false);
  });

  test('does not match a host that merely contains the listed string', () => {
    expect(matches('notsteamcommunity-gift.ru')).toBe(false);
    expect(matches('steamcommunity-gift.ru.com')).toBe(false);
  });

  test('does not match when the listed domain is a label of somebody else’s host', () => {
    // A classic: the blocked name appears in full, but the site is evil.net's.
    expect(matches('steamcommunity-gift.ru.evil.net')).toBe(false);
  });

  test('does not match the real site the listed domain impersonates', () => {
    expect(matches('steamcommunity.com')).toBe(false);
    expect(matches('store.steampowered.com')).toBe(false);
  });
});
