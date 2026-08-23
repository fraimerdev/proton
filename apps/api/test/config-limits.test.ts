import { describe, expect, test } from 'bun:test';
import { limitFor } from '@proton/core';
import { overLimit } from '../src/modules/service.ts';

const LIMITS = [{ key: 'savedTemplates' as const, path: 'saved' }];

function list(length: number): Record<string, unknown> {
  return { saved: Array.from({ length }, (_, index) => ({ name: `embed-${index}` })) };
}

describe('overLimit', () => {
  test('allows a list exactly at the tier ceiling', () => {
    expect(overLimit(LIMITS, list(limitFor('free', 'savedTemplates')), 'free')).toBeNull();
  });

  test('refuses one past it, naming the tier, the ceiling and what was saved', () => {
    const reason = overLimit(LIMITS, list(limitFor('free', 'savedTemplates') + 1), 'free');

    expect(reason).toContain('free');
    expect(reason).toContain(String(limitFor('free', 'savedTemplates')));
    expect(reason).toContain(String(limitFor('free', 'savedTemplates') + 1));
    expect(reason).toContain('plus');
  });

  test('judges against the guild’s own tier, not the free one', () => {
    const overFree = list(limitFor('free', 'savedTemplates') + 1);

    expect(overLimit(LIMITS, overFree, 'free')).not.toBeNull();
    expect(overLimit(LIMITS, overFree, 'plus')).toBeNull();
  });

  test('a module declaring no limits is never refused', () => {
    expect(overLimit([], list(10_000), 'free')).toBeNull();
  });

  test('a path that is missing or not an array is ignored rather than treated as empty', () => {
    expect(overLimit(LIMITS, {}, 'free')).toBeNull();
    expect(overLimit(LIMITS, { saved: 'not an array' }, 'free')).toBeNull();
  });

  test('reads a nested path', () => {
    const limits = [{ key: 'counters' as const, path: 'nested.counters' }];
    const config = { nested: { counters: Array.from({ length: 9_999 }, () => ({})) } };

    expect(overLimit(limits, config, 'free')).toContain('counter channels');
  });

  test('a nested path through a non-object is ignored, not a crash', () => {
    const limits = [{ key: 'counters' as const, path: 'nested.counters' }];

    expect(overLimit(limits, { nested: null }, 'free')).toBeNull();
  });

  test('reports the first limit crossed when a module declares several', () => {
    const limits = [
      { key: 'savedTemplates' as const, path: 'saved' },
      { key: 'counters' as const, path: 'counters' },
    ];

    const config = {
      ...list(limitFor('free', 'savedTemplates') + 1),
      counters: Array.from({ length: limitFor('free', 'counters') + 1 }, () => ({})),
    };

    expect(overLimit(limits, config, 'free')).toContain('saved templates');
  });
});
