import { describe, expect, test } from 'bun:test';
import {
  ABOVE_BOT_ROLE,
  CHANNEL,
  EVERYONE_ROLE,
  GATED,
  GUILD,
  harness,
  MEMBER,
  PANELLED,
  UNVERIFIED_ROLE,
  VERIFIED_ROLE,
  WEBSITE,
} from './harness.ts';

const JTI = 'jti-0000000000000001';

function passed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { guildId: GUILD, userId: MEMBER, jti: JTI, verifiedAt: 1_700_000_000_000, ...overrides };
}

describe('the panel, reconciled every time the guild saves verification', () => {
  test('a save naming a panel channel posts it and remembers the id it will refresh later', async () => {
    const h = harness();

    const outcome = await h.saved({ config: PANELLED });

    if (outcome.action !== 'posted') throw new Error(`expected a post, got ${outcome.action}`);
    expect(h.panel.records.get(GUILD)).toEqual({
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: outcome.messageId,
      postedAt: h.now(),
    });

    const posted = h.sentIn(CHANNEL)[0];
    expect(posted?.allowed_mentions).toEqual({ parse: [] });
  });

  test('renders the copy the guild has just saved, not what it had when it last posted', async () => {
    const h = harness();

    await h.saved({ config: { ...PANELLED, panelTitle: 'Read the rules first' } });

    expect(h.sentIn(CHANNEL)[0]?.content).toContain('Read the rules first');
  });

  test('a second save edits the panel it already posted instead of posting a twin', async () => {
    const h = harness();

    const first = await h.saved({ config: PANELLED });
    const second = await h.saved({ config: PANELLED });

    if (first.action !== 'posted') throw new Error('expected a post');
    expect(second).toEqual({ action: 'edited', messageId: first.messageId });
    expect(h.sentIn(CHANNEL)).toHaveLength(1);
    expect(h.edits()).toHaveLength(1);
  });

  test('forgets a panel somebody deleted and posts a new one, rather than failing forever', async () => {
    const h = harness();

    const first = await h.saved({ config: PANELLED });
    h.rest.fail((call) => call.method === 'PATCH', {
      status: 404,
      body: { message: 'Unknown Message' },
    });

    const second = await h.saved({ config: PANELLED });

    if (first.action !== 'posted' || second.action !== 'posted') {
      throw new Error('expected both saves to end in a posted panel');
    }
    expect(second.messageId).not.toBe(first.messageId);
    expect(h.sentIn(CHANNEL)).toHaveLength(2);
    expect(h.deleted()).toEqual([]);
    expect(h.panel.records.get(GUILD)?.messageId).toBe(second.messageId);
  });

  test('moving the panel to another channel takes the message it left behind down', async () => {
    const h = harness();
    const elsewhere = '500000000000000009';

    const first = await h.saved({ config: PANELLED });
    const moved = await h.saved({ config: { ...PANELLED, panelChannelId: elsewhere } });

    if (first.action !== 'posted' || moved.action !== 'posted') {
      throw new Error('expected the panel to be posted in both channels');
    }
    expect(h.deleted()).toEqual([{ channelId: CHANNEL, messageId: first.messageId }]);
    expect(h.edits()).toEqual([]);
    expect(h.sentIn(elsewhere)).toHaveLength(1);
    expect(h.panel.records.get(GUILD)).toEqual({
      guildId: GUILD,
      channelId: elsewhere,
      messageId: moved.messageId,
      postedAt: h.now(),
    });
  });

  test('clearing the panel channel takes the panel down and forgets it', async () => {
    const h = harness();

    const first = await h.saved({ config: PANELLED });
    const cleared = await h.saved({ config: GATED });

    if (first.action !== 'posted') throw new Error('expected a post');
    expect(cleared).toEqual({ action: 'removed' });
    expect(h.deleted()).toEqual([{ channelId: CHANNEL, messageId: first.messageId }]);
    expect(h.panel.records.get(GUILD)).toBeUndefined();
  });

  test('switching the module off takes the panel down, though the config still names a channel', async () => {
    const h = harness();

    const first = await h.saved({ config: PANELLED });
    const off = await h.saved({ config: PANELLED, enabledAfter: false });

    if (first.action !== 'posted') throw new Error('expected a post');
    expect(off).toEqual({ action: 'removed' });
    expect(h.deleted()).toEqual([{ channelId: CHANNEL, messageId: first.messageId }]);
    expect(h.panel.records.get(GUILD)).toBeUndefined();
  });

  test('a save that wants no panel and left none behind touches nothing', async () => {
    const h = harness();

    const outcome = await h.saved({ config: GATED });

    expect(outcome).toEqual({ action: 'ignored', reason: 'there is no panel and none is wanted' });
    expect(h.discordCalls()).toEqual([]);
  });

  test('another module’s save is left alone — every module hears the same event', async () => {
    const h = harness();

    const outcome = await h.saved({ config: PANELLED, moduleId: 'automod' });

    expect(outcome).toEqual({ action: 'ignored', reason: 'another module was saved' });
    expect(h.discordCalls()).toEqual([]);
    expect(h.panel.records.get(GUILD)).toBeUndefined();
  });

  test('reports Discord’s refusal rather than remembering a panel that was never posted', async () => {
    const h = harness();
    h.rest.fail((call) => call.method === 'POST' && call.path.endsWith('/messages'), {
      status: 403,
      body: { message: 'Missing Access' },
    });

    const outcome = await h.saved({ config: PANELLED });

    expect(outcome.action).toBe('refused');
    expect(h.panel.records.get(GUILD)).toBeUndefined();
  });

  test('names the port a deployment without a panel store is missing', async () => {
    const h = harness();

    const outcome = await h.saved({ config: PANELLED, deps: {} });

    expect(outcome).toEqual({ action: 'refused', reason: 'the panel port is unbound' });
    expect(h.discordCalls()).toEqual([]);

    const error = h.logs.find((entry) => entry.level === 'error');
    expect(error?.message).toContain('RedisPanelStore');
  });

  test('reconciling the panel is not a moderation case, so it never reaches the ledger', async () => {
    const h = harness();

    await h.saved({ config: PANELLED });
    await h.saved({ config: PANELLED });

    expect(h.recorder.recorded).toEqual([]);
  });
});

describe('verification.web_passed', () => {
  test('grants the role for a member who finished on the website', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    const outcome = await h.webPassed(passed(), { config: WEBSITE });

    expect(outcome).toEqual({ action: 'verified', userId: MEMBER });
    expect(h.rolesOf(MEMBER)).toContain(VERIFIED_ROLE);
    expect(h.rolesOf(MEMBER)).not.toContain(UNVERIFIED_ROLE);
  });

  test('ignores a result for a server that no longer verifies on the website', async () => {
    const h = harness();

    const outcome = await h.webPassed(passed(), { config: GATED });

    expect(outcome).toEqual({
      action: 'ignored',
      reason: 'this server no longer verifies on the website',
    });
    expect(h.roleCalls()).toEqual([]);
  });

  test('logs loudly when the role cannot be granted — nobody is in Discord to be told', async () => {
    const h = harness();

    const outcome = await h.webPassed(passed(), {
      config: { ...WEBSITE, verifiedRoleId: ABOVE_BOT_ROLE },
    });

    expect(outcome.action).toBe('refused');
    expect(h.roleCalls()).toEqual([]);

    const error = h.logs.find((entry) => entry.level === 'error');
    expect(error?.message).toContain(MEMBER);
    expect(error?.message).toContain('NOT given their role');
    expect(error?.message).toContain('position 9');
  });

  test('says so instead of silently dropping a result it cannot read', async () => {
    const h = harness();

    const outcome = await h.webPassed({ guildId: GUILD }, { config: WEBSITE });

    expect(outcome).toEqual({ action: 'ignored', reason: 'unreadable website result' });
    expect(h.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  test('names the port a deployment without guild state is missing', async () => {
    const h = harness();

    const outcome = await h.webPassed(passed(), { config: WEBSITE, deps: {} });

    expect(outcome).toEqual({ action: 'refused', reason: 'the gate port is unbound' });

    const error = h.logs.find((entry) => entry.level === 'error');
    expect(error?.message).toContain('RedisGuildStateStore');
  });
});
