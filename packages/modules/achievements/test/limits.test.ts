import { describe, expect, test } from 'bun:test';
import { MemoryLimits } from './memory-voice-store.ts';

const KEY = 'proton:achievements:reset:900000000000000001:abc:1';

describe('MemoryLimits', () => {
  test('a claim refuses every other value until it is released', async () => {
    const clock = { now: 1_000 };
    const limits = new MemoryLimits({ now: () => clock.now });

    expect(await limits.claim(KEY, 'press-1', 60_000)).toBe(true);
    expect(await limits.claim(KEY, 'press-1', 60_000)).toBe(true);
    expect(await limits.claim(KEY, 'press-2', 60_000)).toBe(false);

    expect(await limits.release(KEY, 'press-1')).toBe(true);
    expect(await limits.claim(KEY, 'press-2', 60_000)).toBe(true);
  });

  test('release leaves a claim someone else holds, and one that has already expired', async () => {
    const clock = { now: 1_000 };
    const limits = new MemoryLimits({ now: () => clock.now });

    await limits.claim(KEY, 'press-1', 60_000);

    expect(await limits.release(KEY, 'press-2')).toBe(false);
    expect(await limits.claim(KEY, 'press-2', 60_000)).toBe(false);

    clock.now += 60_000;
    expect(await limits.release(KEY, 'press-1')).toBe(false);
  });
});
