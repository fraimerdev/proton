import { describe, expect, test } from 'bun:test';
import { zodToDescriptors } from '@proton/core';
import { LOG_EVENT_KEYS, LOG_EVENTS, specByKey } from '../src/catalogue.ts';
import {
  type ServerlogConfig,
  serverlogConfigSchema,
  serverlogDefaultConfig,
  serverlogFormSchema,
} from '../src/config.ts';
import { isIgnored, logChannelIds, resolveDestination } from '../src/routing.ts';

const DEFAULT_CHANNEL = '500000000000000001';
const MEMBERS_CHANNEL = '500000000000000002';
const EVENT_CHANNEL = '500000000000000003';

function config(overrides: Partial<ServerlogConfig> = {}): ServerlogConfig {
  return serverlogConfigSchema.parse({ enabled: true, ...overrides });
}

function spec(key: string) {
  const found = specByKey(key);
  if (!found) throw new Error(`unknown log key ${key}`);
  return found;
}

describe('resolveDestination', () => {
  test('falls back to the default channel', () => {
    expect(
      resolveDestination(config({ defaultChannelId: DEFAULT_CHANNEL }), spec('members.joined')),
    ).toEqual({ channelId: DEFAULT_CHANNEL });
  });

  test('a category channel beats the default', () => {
    const cfg = config({
      defaultChannelId: DEFAULT_CHANNEL,
      categoryChannels: { ...serverlogDefaultConfig.categoryChannels, members: MEMBERS_CHANNEL },
    });

    expect(resolveDestination(cfg, spec('members.joined'))).toEqual({ channelId: MEMBERS_CHANNEL });
  });

  test('a per-event channel beats the category', () => {
    const cfg = config({
      defaultChannelId: DEFAULT_CHANNEL,
      categoryChannels: { ...serverlogDefaultConfig.categoryChannels, members: MEMBERS_CHANNEL },
      events: { 'members.joined': { channelId: EVENT_CHANNEL } },
    });

    expect(resolveDestination(cfg, spec('members.joined'))).toEqual({ channelId: EVENT_CHANNEL });
  });

  test('no channel anywhere means no log', () => {
    expect(resolveDestination(config(), spec('members.joined'))).toBeNull();
  });

  test('a category that is off silences its events', () => {
    const cfg = config({
      defaultChannelId: DEFAULT_CHANNEL,
      categories: { ...serverlogDefaultConfig.categories, members: false },
    });

    expect(resolveDestination(cfg, spec('members.joined'))).toBeNull();
  });

  test('a per-event "on" beats a category that is off', () => {
    const cfg = config({
      defaultChannelId: DEFAULT_CHANNEL,
      categories: { ...serverlogDefaultConfig.categories, moderation: false },
      events: { 'moderation.member_banned': { enabled: true } },
    });

    expect(resolveDestination(cfg, spec('moderation.member_banned'))).toEqual({
      channelId: DEFAULT_CHANNEL,
    });
    expect(resolveDestination(cfg, spec('moderation.member_kicked'))).toBeNull();
  });

  test('a per-event "off" beats a category that is on', () => {
    const cfg = config({
      defaultChannelId: DEFAULT_CHANNEL,
      events: { 'members.joined': { enabled: false } },
    });

    expect(resolveDestination(cfg, spec('members.joined'))).toBeNull();
    expect(resolveDestination(cfg, spec('members.left'))).not.toBeNull();
  });

  test('messages and voice are off by default, because they are the noisy ones', () => {
    expect(serverlogDefaultConfig.categories.messages).toBe(false);
    expect(serverlogDefaultConfig.categories.voice).toBe(false);
  });
});

describe('logChannelIds', () => {
  test('collects every destination an admin configured', () => {
    const cfg = config({
      defaultChannelId: DEFAULT_CHANNEL,
      categoryChannels: { ...serverlogDefaultConfig.categoryChannels, members: MEMBERS_CHANNEL },
      events: { 'members.joined': { channelId: EVENT_CHANNEL } },
    });

    expect([...logChannelIds(cfg)].sort()).toEqual(
      [DEFAULT_CHANNEL, MEMBERS_CHANNEL, EVENT_CHANNEL].sort(),
    );
  });

  test('an unconfigured guild has no destinations', () => {
    expect(logChannelIds(config()).size).toBe(0);
  });
});

describe('isIgnored', () => {
  test('a log channel never logs itself, however busy it is', () => {
    const cfg = config({ defaultChannelId: DEFAULT_CHANNEL });

    expect(isIgnored(cfg, { channelId: DEFAULT_CHANNEL })).toBe(true);
  });

  test('an ignored channel is skipped', () => {
    const cfg = config({ ignoredChannelIds: [MEMBERS_CHANNEL] });

    expect(isIgnored(cfg, { channelId: MEMBERS_CHANNEL })).toBe(true);
    expect(isIgnored(cfg, { channelId: EVENT_CHANNEL })).toBe(false);
  });

  test('an ignored user is skipped', () => {
    const cfg = config({ ignoredUserIds: ['100000000000000002'] });

    expect(isIgnored(cfg, { actorId: '100000000000000002' })).toBe(true);
  });

  test('an ignored role is skipped', () => {
    const cfg = config({ ignoredRoleIds: ['700000000000000001'] });

    expect(isIgnored(cfg, { actorRoleIds: ['700000000000000001'] })).toBe(true);
    expect(isIgnored(cfg, { actorRoleIds: ['700000000000000009'] })).toBe(false);
  });

  test('bots are only skipped when the guild asks', () => {
    expect(isIgnored(config(), { actorIsBot: true })).toBe(false);
    expect(isIgnored(config({ ignoreBots: true }), { actorIsBot: true })).toBe(true);
  });

  test('nothing is ignored by default', () => {
    expect(isIgnored(config(), { channelId: EVENT_CHANNEL, actorId: '1' })).toBe(false);
  });
});

describe('config shape', () => {
  test('the generated form can render every field it is given', () => {
    expect(() => zodToDescriptors(serverlogFormSchema)).not.toThrow();
  });

  test('the full schema cannot be rendered, which is why formSchema exists', () => {
    expect(() => zodToDescriptors(serverlogConfigSchema)).toThrow();
  });

  test('the per-category objects render as one level of nesting', () => {
    const paths = zodToDescriptors(serverlogFormSchema).map((field) => field.path);

    expect(paths).toContain('categories.members');
    expect(paths).toContain('categoryChannels.members');
  });

  test('category channels render as channel pickers', () => {
    const field = zodToDescriptors(serverlogFormSchema).find(
      (candidate) => candidate.path === 'categoryChannels.moderation',
    );

    expect(field?.kind).toBe('channel-id');
  });

  test('logging is off until an admin turns it on', () => {
    expect(serverlogDefaultConfig.enabled).toBe(false);
    expect(serverlogDefaultConfig.defaultChannelId).toBe('');
    expect(serverlogDefaultConfig.events).toEqual({});
  });

  test('an unknown event key is rejected by name rather than silently kept', () => {
    const result = serverlogConfigSchema.safeParse({ events: { 'members.teleported': {} } });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('members.teleported');
  });

  test('every catalogue key is accepted', () => {
    const events = Object.fromEntries(LOG_EVENT_KEYS.map((key) => [key, { enabled: true }]));

    expect(serverlogConfigSchema.safeParse({ events }).success).toBe(true);
  });

  test('every catalogue entry names a category the config knows', () => {
    for (const key of LOG_EVENT_KEYS) {
      expect(serverlogDefaultConfig.categories).toHaveProperty(LOG_EVENTS[key]?.category ?? '');
    }
  });

  test('every catalogue key is unique', () => {
    expect(new Set(LOG_EVENT_KEYS).size).toBe(LOG_EVENT_KEYS.length);
  });
});
