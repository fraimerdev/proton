import { describe, expect, test } from 'bun:test';
import {
  checkLimit,
  checkListLimit,
  LIMIT_KEYS,
  LIMIT_LABELS,
  type LimitKey,
  limitFor,
  PER_MEMBER_KEYS,
  TIER_LIMITS,
} from '../../src/entitlements/limits.ts';
import { ENTITLEMENT_TIERS, type EntitlementTier } from '../../src/rules/facts.ts';

describe('the table', () => {
  test('the free tier caps are pinned here, so raising one is a deliberate product change', () => {
    expect(TIER_LIMITS.free).toEqual({
      tags: 25,
      activeGiveaways: 3,
      remindersPerUser: 10,
      ticketPanels: 2,
      openTicketsPerUser: 3,
      counters: 5,
      tempVcHubs: 2,
      savedTemplates: 10,
      activePolls: 3,
      honeypotChannels: 3,
    });
  });

  test('every tier answers for every key, so no lookup falls through to undefined', () => {
    for (const tier of ENTITLEMENT_TIERS) {
      expect(Object.keys(TIER_LIMITS[tier]).sort()).toEqual([...LIMIT_KEYS].sort());
    }
  });

  test('every key has a label a member could read', () => {
    for (const key of LIMIT_KEYS) {
      expect(LIMIT_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  test('paying never lowers a cap', () => {
    for (const key of LIMIT_KEYS) {
      expect(limitFor('plus', key)).toBeGreaterThan(limitFor('free', key));
      expect(limitFor('pro', key)).toBeGreaterThan(limitFor('plus', key));
    }
  });
});

describe('checkLimit', () => {
  test('allows one more while there is room', () => {
    expect(checkLimit('free', 'tags', 24)).toEqual({ ok: true });
  });

  test('allows the very first one', () => {
    expect(checkLimit('free', 'tags', 0)).toEqual({ ok: true });
  });

  test('refuses the one that would cross the cap', () => {
    const result = checkLimit('free', 'tags', 25);

    expect(result.ok).toBe(false);
    expect(result.ok ? 0 : result.limit).toBe(25);
    expect(result.ok ? '' : result.tier).toBe('free');
  });

  test('still refuses when a downgrade has left a server over its cap', () => {
    expect(checkLimit('free', 'tags', 200).ok).toBe(false);
  });

  test('names the cap, the tier and the way out — "the bot did nothing" is a bug', () => {
    const result = checkLimit('free', 'activeGiveaways', 3);

    if (result.ok) throw new Error('expected the fourth giveaway to be refused');

    expect(result.humanReason).toContain('free');
    expect(result.humanReason).toContain('3');
    expect(result.humanReason).toContain('running giveaways');
    expect(result.humanReason).toContain('plus');
    expect(result.humanReason).toContain(String(limitFor('plus', 'activeGiveaways')));
  });

  test('the top tier is told it is the top tier, not to upgrade to nothing', () => {
    const result = checkLimit('pro', 'tags', TIER_LIMITS.pro.tags);

    if (result.ok) throw new Error('expected the cap to be refused');

    expect(result.humanReason).toContain('pro');
    expect(result.humanReason).toContain('highest tier');
  });

  test('a paid tier gets its own cap, not the free one', () => {
    expect(checkLimit('plus', 'tags', 25).ok).toBe(true);
    expect(checkLimit('plus', 'tags', TIER_LIMITS.plus.tags).ok).toBe(false);
  });
});

const everyPair: [EntitlementTier, LimitKey][] = ENTITLEMENT_TIERS.flatMap((tier) =>
  LIMIT_KEYS.map((key): [EntitlementTier, LimitKey] => [tier, key]),
);

describe('every tier against every key', () => {
  test.each(everyPair)('%s / %s allows one below the cap and refuses at it', (tier, key) => {
    const limit = limitFor(tier, key);

    expect(checkLimit(tier, key, limit - 1)).toEqual({ ok: true });
    expect(checkLimit(tier, key, limit).ok).toBe(false);
    expect(checkLimit(tier, key, limit + 1).ok).toBe(false);
  });

  test.each(everyPair)('%s / %s reports the cap it just enforced', (tier, key) => {
    const refused = checkLimit(tier, key, limitFor(tier, key));

    if (refused.ok) throw new Error(`expected ${tier}/${key} to be refused at its cap`);

    expect(refused.limit).toBe(limitFor(tier, key));
    expect(refused.tier).toBe(tier);
  });

  test.each(everyPair)(
    '%s / %s names the tier, the cap and the thing being capped',
    (tier, key) => {
      const refused = checkLimit(tier, key, limitFor(tier, key));

      if (refused.ok) throw new Error(`expected ${tier}/${key} to be refused at its cap`);

      expect(refused.humanReason).toContain(tier);
      expect(refused.humanReason).toContain(String(limitFor(tier, key)));
      expect(refused.humanReason).toContain(LIMIT_LABELS[key]);
    },
  );

  test.each(everyPair)('%s / %s always has room for the first one', (tier, key) => {
    expect(checkLimit(tier, key, 0)).toEqual({ ok: true });
  });
});

describe('the way out of a refusal', () => {
  test.each(everyPair.filter(([tier]) => tier !== 'pro'))(
    '%s / %s points at the next tier up and the cap it would buy',
    (tier, key) => {
      const refused = checkLimit(tier, key, limitFor(tier, key));
      const next = ENTITLEMENT_TIERS[ENTITLEMENT_TIERS.indexOf(tier) + 1];

      if (refused.ok) throw new Error(`expected ${tier}/${key} to be refused at its cap`);
      if (!next) throw new Error(`expected a tier above ${tier}`);

      expect(refused.humanReason).toContain(next);
      expect(refused.humanReason).toContain(String(limitFor(next, key)));
    },
  );

  test.each([...LIMIT_KEYS])('pro / %s is told it is already the top tier', (key) => {
    const refused = checkLimit('pro', key, limitFor('pro', key));

    if (refused.ok) throw new Error(`expected pro/${key} to be refused at its cap`);

    expect(refused.humanReason).toContain('highest tier');
    expect(refused.humanReason).not.toContain('move to');
  });
});

describe('checkListLimit', () => {
  test.each(everyPair)('%s / %s allows a list of exactly the cap', (tier, key) => {
    expect(checkListLimit(tier, key, limitFor(tier, key)).ok).toBe(true);
  });

  test.each(everyPair)('%s / %s refuses one past the cap', (tier, key) => {
    expect(checkListLimit(tier, key, limitFor(tier, key) + 1).ok).toBe(false);
  });

  test.each(everyPair)('%s / %s allows an empty list', (tier, key) => {
    expect(checkListLimit(tier, key, 0).ok).toBe(true);
  });

  test('reports the length that was offered, not a count nobody typed', () => {
    const refused = checkListLimit(
      'free',
      'savedTemplates',
      limitFor('free', 'savedTemplates') + 4,
    );

    if (refused.ok) throw new Error('expected a refusal');

    expect(refused.humanReason).toContain(String(limitFor('free', 'savedTemplates') + 4));
    expect(refused.humanReason).toContain(String(limitFor('free', 'savedTemplates')));
  });

  test('is one entry more permissive than checkLimit, which counts what already exists', () => {
    const cap = limitFor('free', 'tags');

    expect(checkLimit('free', 'tags', cap).ok).toBe(false);
    expect(checkListLimit('free', 'tags', cap).ok).toBe(true);
  });
});

describe('who the refusal is addressed to', () => {
  test.each([...PER_MEMBER_KEYS])('%s is counted per member, so it says "you"', (key) => {
    const refused = checkLimit('free', key, limitFor('free', key));

    if (refused.ok) throw new Error('expected a refusal');

    expect(refused.humanReason).toContain('you are already at');
    expect(refused.humanReason).not.toContain('this server is already at');
  });

  test.each([...LIMIT_KEYS].filter((key) => !PER_MEMBER_KEYS.has(key)))(
    '%s is counted per guild, so it says "this server"',
    (key) => {
      const refused = checkLimit('free', key, limitFor('free', key));

      if (refused.ok) throw new Error('expected a refusal');

      expect(refused.humanReason).toContain('this server is already at');
    },
  );
});
