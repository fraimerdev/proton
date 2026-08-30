import { describe, expect, test } from 'bun:test';
import {
  CAMO_INTERVAL_MS,
  CAMO_JOB,
  CAMO_KEY,
  camouflageName,
  daySlot,
  KEEP_ALIVE_LINES,
} from '../src/camouflage.ts';
import { armed, harness, LOUNGE, TRAP, trap } from './harness.ts';

const POSTS = armed({ keepChannelActive: true });
const RENAMES = armed({ renameChannelDaily: true });

describe('booking the daily job', () => {
  test('a save with neither leg on books nothing', async () => {
    const h = harness();

    await h.saved({ config: armed() });

    expect(h.booked).toEqual([]);
  });

  test('a save with a leg on books one job, under one key', async () => {
    const h = harness();

    await h.saved({ config: POSTS });

    expect(h.booked.map((job) => [job.jobId, job.naturalKey])).toEqual([[CAMO_JOB, CAMO_KEY]]);
  });

  test('turning both legs off again cancels it', async () => {
    const h = harness();

    await h.saved({ config: POSTS });
    await h.saved({ config: armed() });

    expect(h.cancelled).toEqual([{ jobId: CAMO_JOB, naturalKey: CAMO_KEY }]);
    expect(h.booked).toEqual([]);
  });

  test('switching the module off cancels it, on the event alone', async () => {
    const h = harness();

    await h.saved({ config: POSTS });
    await h.saved({ config: POSTS, enabledAfter: false });

    expect(h.booked).toEqual([]);
  });

  test('a server with no armed bait channel books nothing to camouflage', async () => {
    const h = harness();

    await h.saved({ config: { ...POSTS, channels: [trap({ enabled: false })] } });

    expect(h.booked).toEqual([]);
  });
});

describe('keeping the channel active', () => {
  test('posts into every armed bait channel', async () => {
    const h = harness();

    await h.saved({ config: { ...POSTS, postNotice: false } });
    await h.runDue(CAMO_JOB, CAMO_KEY, { ...POSTS, postNotice: false });

    expect(h.sentIn(TRAP)).toHaveLength(1);
  });

  test('says nothing anybody would answer', async () => {
    const h = harness();

    await h.saved({ config: POSTS });
    await h.runDue(CAMO_JOB, CAMO_KEY, POSTS);

    expect([...KEEP_ALIVE_LINES] as string[]).toContain(String(h.sentIn(TRAP).at(-1)?.content));
  });

  // Proton's own message must never spring Proton's own trap.
  test('the post it makes does not trip the trap it is hiding', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: POSTS,
      authorId: h.deps.botUserId as string,
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'self' });
  });

  test('mentions nobody', async () => {
    const h = harness();

    await h.saved({ config: POSTS });
    await h.runDue(CAMO_JOB, CAMO_KEY, POSTS);

    expect(h.sentIn(TRAP).at(-1)?.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('renaming the channel', () => {
  test('renames every armed bait channel', async () => {
    const h = harness();

    await h.saved({ config: { ...RENAMES, channels: [trap(), trap({ channelId: LOUNGE })] } });
    await h.runDue(CAMO_JOB, CAMO_KEY, {
      ...RENAMES,
      channels: [trap(), trap({ channelId: LOUNGE })],
    });

    expect(h.calls().filter((call) => call.startsWith('PATCH /channels/'))).toHaveLength(2);
  });

  // The same day redelivered must produce the same name, or a retry spends a second rename out of
  // an allowance of two per ten minutes.
  test('the name is a function of the day and the channel, not of chance', () => {
    const slot = daySlot(1_700_000_000_000);

    expect(camouflageName('traps', TRAP, slot)).toBe(camouflageName('traps', TRAP, slot));
    expect(camouflageName('traps', TRAP, slot)).not.toBe(camouflageName('traps', LOUNGE, slot));
  });

  test('does not stack a suffix on a name it gave the channel yesterday', () => {
    const yesterday = camouflageName('traps', TRAP, 1);
    const today = camouflageName(yesterday, TRAP, 2);

    expect(today.split('-')).toHaveLength(2);
    expect(today.startsWith('traps-')).toBe(true);
  });

  test('says so rather than guessing when it does not know the current name', async () => {
    const h = harness();
    const config = { ...RENAMES, channels: [trap({ channelId: '500000000000009999' })] };

    await h.saved({ config });
    await h.runDue(CAMO_JOB, CAMO_KEY, config);

    expect(h.said('warn').join(' ')).toContain(
      'does not know what this channel is currently called',
    );
  });
});

describe('the job keeping itself alive', () => {
  test('books tomorrow’s run before it finishes', async () => {
    const h = harness();

    await h.saved({ config: POSTS });
    await h.runDue(CAMO_JOB, CAMO_KEY, POSTS);

    expect(h.booked.map((job) => job.jobId)).toEqual([CAMO_JOB]);
    expect(h.booked[0]?.runAt).toBe(h.now() + CAMO_INTERVAL_MS);
  });

  test('stops rescheduling itself once both legs are off', async () => {
    const h = harness();

    await h.saved({ config: POSTS });
    await h.runDue(CAMO_JOB, CAMO_KEY, armed());

    expect(h.said('info').join(' ')).toContain('camouflage stopped');
  });
});
