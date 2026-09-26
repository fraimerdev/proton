import { describe, expect, test } from 'bun:test';
import type { EventType } from '@proton/core';
import { ACHIEVEMENT_LISTENER_TYPES, createAchievementsListeners } from '../src/listeners.ts';
import { handleVoiceState } from '../src/voice.ts';
import {
  deliver,
  event,
  fixture,
  GUILD,
  harness,
  MEMBER,
  messagePayload,
  T0,
  VOICE,
} from './collect-fakes.ts';

const DESIGN_TYPES: EventType[] = [
  'message.created',
  'reaction.added',
  'voice.state_updated',
  'guild.available',
  'member.joined',
  'member.updated',
  'member.left',
  'xp.awarded',
  'xp.level_gained',
  'xp.granted',
  'starboard.message_posted',
  'giveaways.entered',
  'giveaways.drop_claimed',
  'giveaways.ended',
  'giveaways.rerolled',
  'giveaways.cancelled',
  'applications.accepted',
  'achievements.unlocked',
  'achievements.reward_retry_requested',
  'achievements.job_requested',
  'proton.config_changed',
];

function configChanged(moduleId: string, enabledAfter: boolean) {
  return event('proton.config_changed', {
    auditId: 'audit-1',
    guildId: GUILD,
    moduleId,
    actorId: MEMBER,
    source: 'dashboard',
    enabledBefore: true,
    enabledAfter,
    changedKeys: ['enabled'],
  });
}

async function openSession(h: ReturnType<typeof harness>) {
  await handleVoiceState(
    h.ctx(),
    h.deps,
    event('voice.state_updated', fixture('voiceStateJoin'), { occurredAt: T0 }),
    h.engine,
  );
}

describe('achievements listeners', () => {
  test('listen to exactly the non-interaction types of the design, each once', () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);
    const types = listeners.flatMap((listener) => listener.types);

    expect(new Set(types)).toEqual(new Set(DESIGN_TYPES));
    expect(types).toHaveLength(DESIGN_TYPES.length);
    expect(new Set(ACHIEVEMENT_LISTENER_TYPES)).toEqual(new Set(DESIGN_TYPES));
    expect(listeners.every((listener) => listener.types.length > 0)).toBe(true);
  });

  test('route a message to its collector and on to the engine', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);

    await deliver(listeners, event('message.created', messagePayload()), h.ctx());

    expect(h.engine.records().map((record) => record.metric)).toEqual(['messages', 'active_days']);
  });

  test('route an accepted application to its collector, with no channel to announce in', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);

    await deliver(
      listeners,
      event('applications.accepted', {
        guildId: GUILD,
        applicationId: '01J9ZK4N7Q2X5V8B3C6D9F0G1H',
        number: 12,
        formId: 'moderator',
        formName: 'Moderator Application',
        versionId: '01J9ZK4N7Q2X5V8B3C6D9F0G1J',
        applicantId: MEMBER,
        actorId: 'proton:applications',
        revision: 1,
        status: 'accepted',
        occurredAt: T0,
      }),
      h.ctx(),
    );

    expect(h.engine.records().map((record) => record.metric)).toEqual(['applications_accepted']);
    expect(h.engine.processed[0]?.originChannelId).toBeNull();
  });

  test('count nothing while the config is off, but still settle what is already in flight', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);
    const off = h.ctx({ enabled: false });

    await deliver(listeners, event('message.created', messagePayload()), off);
    await deliver(listeners, event('guild.available', fixture('guildCreate')), off);
    await deliver(listeners, event('achievements.job_requested', {}), off);
    await deliver(listeners, event('achievements.reward_retry_requested', {}), off);
    await deliver(listeners, event('xp.granted', { sourceModule: 'achievements' }), off);
    await deliver(listeners, configChanged('achievements', false), off);

    expect(h.engine.processed).toEqual([]);
    expect(h.engine.handled.map((call) => call.name)).toEqual([
      'jobRequest',
      'retryRequest',
      'xpGranted',
      'configChanged',
    ]);
  });

  test('ignore other modules’ config changes and close voice when this one turns off', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);
    await openSession(h);

    await deliver(listeners, configChanged('leveling', false), h.ctx({ enabled: false }));
    expect(h.engine.handled).toEqual([]);
    expect(await h.voice.list(GUILD)).toHaveLength(1);

    h.engine.change = { turnedOff: true, turnedOn: false };
    await deliver(listeners, configChanged('achievements', false), h.ctx({ enabled: false }));

    expect(h.engine.handled.map((call) => call.name)).toEqual(['configChanged']);
    expect(await h.voice.list(GUILD)).toEqual([]);
    expect(h.engine.processed).toEqual([]);
  });

  test('keep voice open when a config change does not turn the module off', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);
    await openSession(h);

    await deliver(listeners, configChanged('achievements', true), h.ctx());

    expect(await h.voice.list(GUILD)).toHaveLength(1);
  });

  test('recover on guild.available: the engine first, then voice reconciliation', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);

    await deliver(
      listeners,
      event('guild.available', {
        ...fixture('guildCreate'),
        voice_states: [{ user_id: MEMBER, channel_id: VOICE, self_deaf: false, deaf: false }],
        members: [{ user: { id: MEMBER, bot: false }, roles: [] }],
      }),
      h.ctx(),
    );

    expect(h.engine.handled.map((call) => call.name)).toEqual(['guildAvailable']);
    expect(await h.voice.get(GUILD, MEMBER)).toMatchObject({ channelId: VOICE, joinedAt: T0 });
  });

  test('hand XP confirmations meant for achievements, retries and jobs to the engine', async () => {
    const h = harness();
    const listeners = createAchievementsListeners(h.deps, h.engine);

    await deliver(listeners, event('xp.granted', { sourceModule: 'rules' }), h.ctx());
    await deliver(listeners, event('xp.granted', { sourceModule: 'achievements' }), h.ctx());
    await deliver(listeners, event('achievements.reward_retry_requested', {}), h.ctx());
    await deliver(listeners, event('achievements.job_requested', {}), h.ctx());

    expect(h.engine.handled.map((call) => call.name)).toEqual([
      'xpGranted',
      'retryRequest',
      'jobRequest',
    ]);
  });

  test('say which constructor is missing when the store is not bound', async () => {
    const h = harness({ omit: ['store'] });
    const listeners = createAchievementsListeners(h.deps, h.engine);

    await deliver(listeners, event('message.created', messagePayload()), h.ctx());
    await deliver(listeners, event('achievements.job_requested', {}), h.ctx());
    await deliver(listeners, configChanged('achievements', true), h.ctx());

    expect(h.engine.processed).toEqual([]);
    expect(h.engine.handled).toEqual([]);
    expect(h.logs).toHaveLength(3);
    for (const line of h.logs) expect(line).toContain('store: new DrizzleAchievementStore(db)');
  });

  test('build cleanly with no ports at all', () => {
    expect(createAchievementsListeners({}).length).toBeGreaterThan(0);
  });
});
