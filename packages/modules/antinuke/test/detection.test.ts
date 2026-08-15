import { describe, expect, test } from 'bun:test';
import {
  ALERT_CHANNEL,
  auditEvent,
  BOT,
  type FakeRateWindow,
  GUILD,
  harness,
  NOW,
  NUKER,
  OWNER,
} from './harness.ts';

function windowOf(h: ReturnType<typeof harness>) {
  return h.rateWindow as FakeRateWindow;
}

describe('counting destructive audit events', () => {
  test('counts the actor and does nothing while the window is uncrossed', async () => {
    const h = harness();

    const outcome = await h.handle(auditEvent('channel.deleted'));

    expect(outcome.action).toBe('counted');
    expect(h.rest.calls).toEqual([]);
    expect(windowOf(h).hits).toHaveLength(1);
  });

  test('keys the window on the actor and on when the act happened, never on arrival', async () => {
    const h = harness();
    const event = auditEvent('channel.deleted', { occurredAt: NOW - 4_000 });

    await h.handle(event);

    const hit = windowOf(h).hits[0];
    expect(hit?.actorId).toBe(NUKER);
    expect(hit?.guildId).toBe(GUILD);
    // The entry's own timestamp. Using the clock would compress a burst that was
    // spread out, and would disagree with itself on a RESUME replay (§15).
    expect(hit?.now).toBe(NOW - 4_000);
    // Deduped on the event id, so a redelivered entry is not counted twice (I4).
    expect(hit?.member).toBe(event.id);
  });

  test('gives each class its own window, and one window to bans and kicks together', async () => {
    const h = harness();

    await h.handle(auditEvent('channel.deleted'));
    await h.handle(auditEvent('role.deleted'));
    await h.handle(auditEvent('member.banned'));
    await h.handle(auditEvent('member.kicked'));

    expect(windowOf(h).hits.map((hit) => hit.ruleId)).toEqual([
      'antinuke:channelDelete',
      'antinuke:roleDelete',
      'antinuke:memberRemove',
      'antinuke:memberRemove',
    ]);
  });

  test('reads the limit and window for the class from config', async () => {
    const h = harness();

    await h.handle(auditEvent('emoji.deleted'), { emojiDeleteLimit: 7, emojiDeleteWindow: '2m' });

    expect(windowOf(h).hits[0]?.limit).toBe(7);
    expect(windowOf(h).hits[0]?.windowMs).toBe(120_000);
  });

  test('says which threshold it could not read rather than watching nothing quietly', async () => {
    const h = harness();

    // A row written by an older build: the schema refuses this on write (I5), so
    // the only way here is storage that predates the check.
    const outcome = await h.handle(auditEvent('channel.deleted'), {
      channelDeleteWindow: 'whenever',
    });

    expect(outcome.action).toBe('ignored');
    expect(h.logged('error', 'not a duration I can read')).toBe(true);
    expect(windowOf(h).hits).toEqual([]);
  });
});

describe('who is not counted', () => {
  test('ignores Proton itself, so the breaker cannot react to its own ban', async () => {
    const h = harness();

    const outcome = await h.handle(auditEvent('member.banned', { actorId: BOT }));

    expect(outcome).toEqual({ action: 'ignored', reason: 'the actor is Proton itself' });
    expect(windowOf(h).hits).toEqual([]);
  });

  test('ignores entries Discord attributes to nobody', async () => {
    const h = harness();

    const outcome = await h.handle(auditEvent('channel.deleted', { actorId: null }));

    expect(outcome.action).toBe('ignored');
    expect(windowOf(h).hits).toEqual([]);
  });

  test('still counts the guild owner — only the response treats them differently', async () => {
    const h = harness();

    const outcome = await h.handle(auditEvent('channel.deleted', { actorId: OWNER }));

    expect(outcome.action).toBe('counted');
    expect(windowOf(h).hits[0]?.actorId).toBe(OWNER);
  });

  test('does nothing at all when the module is switched off in this guild', async () => {
    const h = harness();

    const outcome = await h.handle(auditEvent('channel.deleted'), { enabled: false });

    expect(outcome.action).toBe('ignored');
    expect(windowOf(h).hits).toEqual([]);
  });

  test('ignores an event class it does not count', async () => {
    const h = harness();

    const outcome = await h.handle(auditEvent('channel.created'));

    expect(outcome).toEqual({
      action: 'ignored',
      reason: 'channel.created is not a class anti-nuke counts',
    });
  });

  test('refuses an audit payload it cannot parse, and says it is a normaliser mismatch', async () => {
    const h = harness();
    const event = auditEvent('channel.deleted');
    event.payload = { entryId: 'not-a-snowflake' };

    const outcome = await h.handle(event);

    expect(outcome.action).toBe('ignored');
    expect(h.logged('error', 'gateway/normaliser mismatch')).toBe(true);
  });
});

describe('unbound dependencies', () => {
  test('says the server is not protected, and names every missing port', async () => {
    const h = harness({ omit: ['rateWindow', 'botUserId'] });

    const outcome = await h.handle(auditEvent('channel.deleted'));

    expect(outcome.action).toBe('ignored');
    const line = h.logs.find((l) => l.level === 'error')?.message ?? '';
    expect(line).toContain('is NOT protecting it');
    expect(line).toContain('rateWindow');
    expect(line).toContain('botUserId');
    expect(line).toContain('createAntinukeModule(');
    // The ports that *are* bound must not be reported as missing.
    expect(line).not.toContain('guildState');
  });
});

describe('maintenance mode', () => {
  const window = {
    guildId: GUILD,
    enabledBy: '100000000000000001',
    reason: 'channel restructure',
    startedAt: NOW - 60_000,
    expiresAt: NOW + 60_000,
  };

  test('suppresses the breaker, and does not even count the act', async () => {
    const h = harness();
    await h.maintenance.set(window);

    const outcome = await h.handle(auditEvent('channel.deleted'), {
      alertChannelId: ALERT_CHANNEL,
    });

    expect(outcome.action).toBe('suppressed');
    // Not counted either: a window left loaded with legitimate bulk work would
    // trip on the first ordinary deletion after maintenance ended.
    expect(windowOf(h).hits).toEqual([]);
    expect(h.rest.calls).toEqual([]);
    expect(h.logged('info', 'anti-nuke suppressed')).toBe(true);
  });

  test('still covers an entry that arrives after the window closed but happened inside it', async () => {
    const h = harness();
    await h.maintenance.set(window);
    // Audit delivery lags: we hear about it two minutes after the window shut.
    h.clock.now = window.expiresAt + 120_000;

    const outcome = await h.handle(
      auditEvent('channel.deleted', { occurredAt: window.expiresAt - 5_000 }),
    );

    expect(outcome.action).toBe('suppressed');
    expect(windowOf(h).hits).toEqual([]);
  });

  test('re-arms once the window has expired, and says so exactly once', async () => {
    const h = harness();
    await h.maintenance.set(window);
    h.clock.now = window.expiresAt + 1_000;

    const first = await h.handle(auditEvent('channel.deleted', { occurredAt: h.clock.now }), {
      alertChannelId: ALERT_CHANNEL,
    });
    const second = await h.handle(auditEvent('channel.deleted', { occurredAt: h.clock.now }), {
      alertChannelId: ALERT_CHANNEL,
    });

    expect(first.action).toBe('counted');
    expect(second.action).toBe('counted');
    expect(windowOf(h).hits).toHaveLength(2);
    expect(h.alertContent()).toContain('maintenance mode ended');
    expect(h.alertContent()).toContain('armed again');
    // Keyed on the window's expiry rather than the event, so a hundred entries
    // observing the same lapse produce one message (I4).
    expect(h.discordCalls().filter((c) => c.path.endsWith('/messages'))).toHaveLength(1);
  });

  test('a window for another guild does not suppress this one', async () => {
    const h = harness();
    await h.maintenance.set({ ...window, guildId: '900000000000000002' });

    const outcome = await h.handle(auditEvent('channel.deleted'));

    expect(outcome.action).toBe('counted');
  });
});
