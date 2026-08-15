import { describe, expect, test } from 'bun:test';
import { ADMIN, ALERT_CHANNEL, GUILD, harness, NOW, stringOption, subcommand } from './harness.ts';

const WINDOW = {
  guildId: GUILD,
  enabledBy: ADMIN,
  reason: null,
  startedAt: NOW - 60_000,
  expiresAt: NOW + 60_000,
};

describe('/antinuke maintenance', () => {
  test('opens a time-boxed window and tells the admin exactly when it closes', async () => {
    const h = harness();

    await h.runCommand(
      subcommand('maintenance', [
        stringOption('duration', '20m'),
        stringOption('reason', 'channel restructure'),
      ]),
      { alertChannelId: ALERT_CHANNEL },
    );

    const stored = await h.maintenance.get(GUILD);
    expect(stored).toMatchObject({
      enabledBy: ADMIN,
      reason: 'channel restructure',
      expiresAt: NOW + 20 * 60_000,
    });
    expect(h.replyContent()).toContain('Maintenance mode is on until');
    expect(h.replyContent()).toContain('/antinuke resume');
  });

  test('audits the fact that the breaker is now off, and who switched it off', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '20m')]), {
      alertChannelId: ALERT_CHANNEL,
    });

    expect(h.logged('warn', 'was switched ON by')).toBe(true);
    const alert = h.alertContent() ?? '';
    expect(alert).toContain(ADMIN);
    expect(alert).toContain('re-arms by itself');

    expect(h.recorder.recorded.some((c) => c.kind === 'interaction_reply')).toBe(true);
  });

  test('refuses a window longer than the guild allows, and says both numbers', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '6h')]));

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('caps maintenance mode at 1h');
    expect(h.replyContent()).toContain('asked for 6h');
  });

  test('refuses a duration it cannot read, in the same words the dashboard uses', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', 'a while')]));

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('not a valid duration');
  });

  test('refuses when the module itself is off, rather than opening a pointless hole', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '20m')]), {
      enabled: false,
    });

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('switched off in this server');
  });

  test('says so when no maintenance store is bound, instead of appearing to work', async () => {
    const h = harness({ omit: ['maintenance'] });

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '20m')]));

    expect(h.replyContent()).toContain('RedisMaintenanceStore');
  });
});

describe('/antinuke resume', () => {
  test('ends the window early and re-arms the breaker', async () => {
    const h = harness();
    await h.maintenance.set(WINDOW);

    await h.runCommand(subcommand('resume'), { alertChannelId: ALERT_CHANNEL });

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('armed again');
    expect(h.logged('warn', 'ended early by')).toBe(true);
  });

  test('says the breaker is already armed rather than pretending to do something', async () => {
    const h = harness();

    await h.runCommand(subcommand('resume'));

    expect(h.replyContent()).toContain('already armed');
  });
});

describe('/antinuke status', () => {
  test('reports every threshold, so nobody has to guess what is being watched', async () => {
    const h = harness();

    await h.runCommand(subcommand('status'));

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('ARMED');
    expect(reply).toContain('channel deletions: 3 per 30s');
    expect(reply).toContain('bans or kicks: 5 per 30s');
    expect(reply).toContain('Nothing irreversible');

    expect(reply).toContain('No alert channel is set');
  });

  test('reports a live maintenance window, with its expiry and who opened it', async () => {
    const h = harness();
    await h.maintenance.set(WINDOW);

    await h.runCommand(subcommand('status'), { alertChannelId: ALERT_CHANNEL });

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('SUSPENDED until');
    expect(reply).toContain(ADMIN);
  });

  test('says plainly when the module is off', async () => {
    const h = harness();

    await h.runCommand(subcommand('status'), { enabled: false });

    expect(h.replyContent()).toContain('OFF in this server');
  });
});
