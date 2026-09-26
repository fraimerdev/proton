import { describe, expect, test } from 'bun:test';
import { MAX_VOICE_STAY_MS } from '@proton/core';
import type { CollectorEngine } from '../src/collect/common.ts';
import { VOICE_CHECKPOINT_MS } from '../src/constants.ts';
import {
  closeAllVoice,
  handleVoiceState,
  reconcileVoice,
  voiceCheckpoint,
  voiceLockKey,
} from '../src/voice.ts';
import {
  AFK,
  BOT,
  CATEGORY,
  DAY,
  event,
  fixture,
  GUILD,
  type Harness,
  type HarnessOptions,
  harness,
  MEMBER,
  MINUTE,
  OTHER,
  OTHER_VOICE,
  ROLE,
  SECOND,
  T0,
  THIRD,
  VOICE,
} from './collect-fakes.ts';

interface VoiceUpdate {
  channelId: string | null;
  userId?: string;
  selfDeaf?: boolean;
  selfMute?: boolean;
  roles?: string[];
  bot?: boolean;
  member?: boolean;
}

function voicePayload(update: VoiceUpdate): Record<string, unknown> {
  const joined = fixture('voiceStateJoin');
  const userId = update.userId ?? MEMBER;
  const payload: Record<string, unknown> = {
    ...joined,
    user_id: userId,
    channel_id: update.channelId,
    self_deaf: update.selfDeaf ?? false,
    self_mute: update.selfMute ?? false,
  };

  if (update.member === false) delete payload.member;
  else {
    payload.member = {
      ...(joined.member as Record<string, unknown>),
      user: { id: userId, bot: update.bot ?? false },
      roles: update.roles ?? [],
    };
  }

  return payload;
}

async function voiceAt(h: Harness, at: number, update: VoiceUpdate, config = {}) {
  h.clock.now = at;
  await handleVoiceState(
    h.ctx(config),
    h.deps,
    event('voice.state_updated', voicePayload(update), { occurredAt: at }),
    h.engine,
  );
}

async function voiceHarness(options: HarnessOptions = {}, periodStart = T0 - DAY) {
  const h = harness(options);
  h.store.setModule(GUILD, { enabled: true, config: { enabled: true } });
  await h.store.syncPeriods(GUILD, periodStart);
  return h;
}

describe('voice sessions', () => {
  test('joining opens a session and arms the checkpoint without counting anything', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    expect(await h.voice.get(GUILD, MEMBER)).toEqual({
      channelId: VOICE,
      joinedAt: T0,
      startedAt: T0,
      lastEventAt: T0,
      temporary: false,
    });
    expect(h.scheduled).toEqual([
      { jobId: 'voice', runAt: T0 + VOICE_CHECKPOINT_MS, naturalKey: 'voice', replace: false },
    ]);
    expect(h.engine.processed).toEqual([]);
  });

  test('leaving records whole minutes, the stay and the active day before closing', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    const leftAt = T0 + 12 * MINUTE + 30 * SECOND;
    await voiceAt(h, leftAt, { channelId: null, member: false });

    expect(h.engine.processed).toHaveLength(1);
    expect(h.engine.processed[0]?.originChannelId).toBeNull();
    expect(h.engine.records()).toMatchObject([
      {
        metric: 'voice_minutes',
        sourceKey: `${MEMBER}:${VOICE}:${T0}`,
        spanStart: T0,
        occurredAt: leftAt,
        amount: 12,
        channelId: VOICE,
        categoryId: CATEGORY,
        temporary: false,
      },
      {
        metric: 'voice_stay',
        sourceKey: `${MEMBER}:${VOICE}:${T0}:${T0}`,
        spanStart: T0,
        amount: 12,
      },
      { metric: 'active_days', sourceKey: `${MEMBER}:2026-09-14` },
    ]);
    expect(await h.voice.get(GUILD, MEMBER)).toBeNull();
  });

  test('moving channel closes one stay and opens the next at the same instant', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + 5 * MINUTE, { channelId: OTHER_VOICE });

    expect(h.engine.records('voice_minutes')).toMatchObject([{ channelId: VOICE, amount: 5 }]);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({
      channelId: OTHER_VOICE,
      joinedAt: T0 + 5 * MINUTE,
      startedAt: T0 + 5 * MINUTE,
    });
  });

  test('deafening ends the stay and undeafening starts a new one; muting changes nothing', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + MINUTE, { channelId: VOICE, selfMute: true });

    expect(h.engine.processed).toEqual([]);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({
      joinedAt: T0,
      lastEventAt: T0 + MINUTE,
    });

    await voiceAt(h, T0 + 3 * MINUTE, { channelId: VOICE, selfDeaf: true });
    expect(h.engine.records('voice_minutes')).toMatchObject([{ amount: 3 }]);
    expect(await h.voice.get(GUILD, MEMBER)).toBeNull();

    await voiceAt(h, T0 + 4 * MINUTE, { channelId: VOICE });
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ joinedAt: T0 + 4 * MINUTE });
  });

  test('stale updates are ignored, before and after the session closes', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + MINUTE, { channelId: VOICE, selfMute: true });
    await voiceAt(h, T0, { channelId: OTHER_VOICE });

    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ channelId: VOICE, joinedAt: T0 });

    await voiceAt(h, T0 + 2 * MINUTE, { channelId: null, member: false });
    await voiceAt(h, T0 + MINUTE + SECOND, { channelId: VOICE });

    expect(await h.voice.get(GUILD, MEMBER)).toBeNull();
    expect(h.engine.processed).toHaveLength(1);
  });

  test('the AFK channel, excluded categories and roles, ticket channels and bots never open', async () => {
    const h = await voiceHarness({ kinds: { [OTHER_VOICE]: 'ticket' } });
    await voiceAt(h, T0, { channelId: AFK });
    await voiceAt(h, T0, { channelId: VOICE, userId: OTHER }, { excludedChannelIds: [CATEGORY] });
    await voiceAt(
      h,
      T0,
      { channelId: VOICE, userId: THIRD, roles: [ROLE] },
      { excludedRoleIds: [ROLE] },
    );
    await voiceAt(h, T0, { channelId: OTHER_VOICE, userId: '100000000000000005' });
    await voiceAt(h, T0, { channelId: VOICE, userId: BOT, bot: true });

    expect(await h.voice.list(GUILD)).toEqual([]);
  });

  test('temporary channels are marked when the session opens', async () => {
    const h = await voiceHarness({ kinds: { [VOICE]: 'temporary' } });
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + 2 * MINUTE, { channelId: null, member: false });

    expect(h.engine.records('voice_minutes')).toMatchObject([{ temporary: true, amount: 2 }]);
  });

  test('a stay under a minute adds nothing but still ends', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + 59 * SECOND, { channelId: null, member: false });

    expect(h.engine.processed).toEqual([]);
    expect(await h.voice.get(GUILD, MEMBER)).toBeNull();
  });

  test('one stay counts at most 24 hours', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + MAX_VOICE_STAY_MS + 30 * SECOND, { channelId: null, member: false });

    expect(h.engine.records('voice_minutes')).toMatchObject([
      { amount: 24 * 60, occurredAt: T0 + MAX_VOICE_STAY_MS },
    ]);
  });

  test('only time inside the module’s current period counts', async () => {
    const h = await voiceHarness({}, T0 + 5 * MINUTE);
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0 + 12 * MINUTE, { channelId: null, member: false });

    expect(h.engine.records()).toMatchObject([
      { metric: 'voice_minutes', spanStart: T0 + 5 * MINUTE, amount: 7 },
      { metric: 'voice_stay', spanStart: T0 + 5 * MINUTE, amount: 7 },
      { metric: 'active_days' },
    ]);
  });

  test('a busy lock makes the update throw so the bus retries it', async () => {
    const h = await voiceHarness();
    await h.locks.acquire(voiceLockKey(GUILD, MEMBER), 60_000);

    await expect(voiceAt(h, T0, { channelId: VOICE })).rejects.toThrow('voice lock');
    expect(await h.voice.get(GUILD, MEMBER)).toBeNull();
  });
});

describe('voice checkpoint', () => {
  test('saves whole minutes, advances the session and reschedules itself', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    h.clock.now = T0 + 25 * MINUTE + 20 * SECOND;
    await voiceCheckpoint({}, h.ctx(), h.deps, h.engine);

    expect(h.engine.keys()).toEqual([
      [
        `voice_minutes:${MEMBER}:${VOICE}:${T0}`,
        `voice_stay:${MEMBER}:${VOICE}:${T0}:${T0}`,
        `active_days:${MEMBER}:2026-09-14`,
      ],
    ]);
    expect(h.engine.records('voice_minutes')).toMatchObject([{ amount: 25 }]);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({
      joinedAt: T0 + 25 * MINUTE,
      startedAt: T0,
    });
    expect(h.scheduled.at(-1)).toEqual({
      jobId: 'voice',
      runAt: h.clock.now + VOICE_CHECKPOINT_MS,
      naturalKey: 'voice',
      replace: false,
    });

    await voiceAt(h, T0 + 32 * MINUTE + 30 * SECOND, { channelId: null, member: false });

    expect(h.engine.keys()[1]).toEqual([
      `voice_minutes:${MEMBER}:${VOICE}:${T0 + 25 * MINUTE}`,
      `voice_stay:${MEMBER}:${VOICE}:${T0}:${T0 + 25 * MINUTE}`,
    ]);
    expect(h.engine.records('voice_minutes').map((record) => record.amount)).toEqual([25, 7]);
    expect(h.engine.records('voice_stay').map((record) => record.amount)).toEqual([25, 32]);
  });

  test('skips members whose lock is held and still reschedules', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    h.clock.now = T0 + 20 * MINUTE;
    await h.locks.acquire(voiceLockKey(GUILD, MEMBER), 60_000);
    await voiceCheckpoint({}, h.ctx(), h.deps, h.engine);

    expect(h.engine.processed).toEqual([]);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ joinedAt: T0 });
    expect(h.scheduled).toHaveLength(2);
  });

  test('closes stays past the cap and stops once no session remains', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    h.clock.now = T0 + MAX_VOICE_STAY_MS + 10 * SECOND;
    await voiceCheckpoint({}, h.ctx(), h.deps, h.engine);

    expect(h.engine.records('voice_minutes')).toMatchObject([{ amount: 24 * 60 }]);
    expect(await h.voice.list(GUILD)).toEqual([]);
    expect(h.scheduled).toHaveLength(1);
  });

  test('the checkpoint after the cap still saves the last minutes of a 24-hour stay', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    h.clock.now = T0 + MAX_VOICE_STAY_MS - 5 * MINUTE;
    await voiceCheckpoint({}, h.ctx(), h.deps, h.engine);

    h.clock.now = T0 + MAX_VOICE_STAY_MS + 5 * MINUTE;
    await voiceCheckpoint({}, h.ctx(), h.deps, h.engine);

    const amounts = (metric: 'voice_minutes' | 'voice_stay') =>
      h.engine.records(metric).map((record) => record.amount);

    expect(amounts('voice_minutes')).toEqual([24 * 60 - 5, 5]);
    expect(Math.max(...amounts('voice_stay'))).toBe(24 * 60);
    expect(await h.voice.list(GUILD)).toEqual([]);
  });

  test('advances the session as soon as the minutes are recorded, even if the rest fails', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    const recorded: string[] = [];
    const failing: CollectorEngine = {
      async processRecords(_ctx, _deps, input) {
        for (const record of input.records) {
          recorded.push(record.metric);
          await input.onRecorded?.(record);
          if (record.metric === 'voice_stay') throw new Error('the ledger is unreachable');
        }
      },
      evaluateMember: async () => undefined,
    };

    h.clock.now = T0 + 10 * MINUTE;
    await voiceCheckpoint({}, h.ctx(), h.deps, failing);

    expect(recorded).toEqual(['voice_minutes', 'voice_stay']);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ joinedAt: T0 + 10 * MINUTE });

    h.clock.now = T0 + 20 * MINUTE;
    await voiceCheckpoint({}, h.ctx(), h.deps, h.engine);

    expect(h.engine.records('voice_minutes')).toMatchObject([
      { sourceKey: `${MEMBER}:${VOICE}:${T0 + 10 * MINUTE}`, amount: 10 },
    ]);
  });

  test('does nothing while the module is off', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });

    h.clock.now = T0 + 20 * MINUTE;
    await voiceCheckpoint({}, h.ctx({ enabled: false }), h.deps, h.engine);

    expect(h.engine.processed).toEqual([]);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ joinedAt: T0 });
  });
});

describe('turning off and reconnecting', () => {
  test('turning the module off ends every stay without counting it', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0, { channelId: VOICE });
    await voiceAt(h, T0, { channelId: OTHER_VOICE, userId: OTHER });

    h.clock.now = T0 + 30 * MINUTE;
    await closeAllVoice(h.ctx({ enabled: false }), h.deps, 'disabled');

    expect(await h.voice.list(GUILD)).toEqual([]);
    expect(h.engine.processed).toEqual([]);
  });

  test('a reconnect adopts stays in progress and drops the ones it no longer sees', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0 - 10 * MINUTE, { channelId: VOICE });
    await voiceAt(h, T0 - 10 * MINUTE, { channelId: OTHER_VOICE, userId: OTHER });

    h.clock.now = T0;
    const available = event(
      'guild.available',
      {
        ...fixture('guildCreate'),
        voice_states: [
          { user_id: MEMBER, channel_id: VOICE, self_deaf: false, deaf: false },
          { user_id: THIRD, channel_id: OTHER_VOICE, self_deaf: false, deaf: false },
          { user_id: BOT, channel_id: VOICE, self_deaf: false, deaf: false },
        ],
        members: [
          { user: { id: THIRD, bot: false }, roles: [ROLE] },
          { user: { id: BOT, bot: true }, roles: [] },
        ],
      },
      { occurredAt: T0 },
    );
    await reconcileVoice(h.ctx(), h.deps, available);

    expect((await h.voice.list(GUILD)).map((open) => [open.userId, open.session.joinedAt])).toEqual(
      [
        [MEMBER, T0 - 10 * MINUTE],
        [THIRD, T0],
      ],
    );
    expect(h.engine.processed).toEqual([]);
    expect(h.scheduled.at(-1)).toMatchObject({ jobId: 'voice', naturalKey: 'voice' });
  });

  test('a reconnect leaves alone stays newer than its snapshot', async () => {
    const h = await voiceHarness();
    await voiceAt(h, T0 + MINUTE, { channelId: VOICE });

    await reconcileVoice(
      h.ctx(),
      h.deps,
      event('guild.available', { ...fixture('guildCreate'), voice_states: [] }, { occurredAt: T0 }),
    );

    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ joinedAt: T0 + MINUTE });
  });
});
