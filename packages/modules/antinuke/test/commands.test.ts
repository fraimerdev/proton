import { describe, expect, test } from 'bun:test';
import {
  formatCommandLabel,
  type RawOption,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import type { AntinukeConfig } from '../src/config.ts';
import type { MaintenanceWindow } from '../src/maintenance.ts';
import {
  ADMIN,
  ALERT_CHANNEL,
  type CallbackBody,
  GUILD,
  type Harness,
  type HarnessOptions,
  harness,
  INTERACTION_TOKEN,
  MemoryMaintenanceStore,
  NOW,
  stringOption,
  subcommand,
} from './harness.ts';

const EPHEMERAL = 64;

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
    expect(h.replyEmbed()?.color).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyEmbed()?.description).toStartWith(STATUS_SUCCESS_EMOJI);
  });

  test('names /antinuke resume as this server has renamed it', async () => {
    const h = harness();

    await h.runCommand(
      subcommand('maintenance', [stringOption('duration', '20m')]),
      {},
      {
        commandLabel: (key, path) =>
          formatCommandLabel(key, path, key === 'antinuke' ? 'shield' : undefined),
      },
    );

    expect(h.replyContent()).toContain("run `/shield resume` as soon as you're done");
    expect(h.replyContent()).not.toContain('/antinuke');
  });

  test('audits the fact that the breaker is now off, and who switched it off', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '20m')]), {
      alertChannelId: ALERT_CHANNEL,
    });

    expect(h.logged('warn', 'started Anti-Nuke maintenance mode')).toBe(true);
    const alert = h.alertContent() ?? '';
    expect(alert).toContain(ADMIN);
    expect(alert).toContain('re-arms by itself');

    expect(h.recorder.recorded.map((c) => c.kind)).toEqual(['send']);
  });

  test('refuses a window longer than the guild allows, and says both numbers', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '6h')]));

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('caps maintenance mode at 1h');
    expect(h.replyContent()).toContain('asked for 6h');
    expect(h.replyEmbed()?.color).toBe(STATUS_ERROR_COLOUR);
    expect(h.replyEmbed()?.description).toStartWith(STATUS_ERROR_EMOJI);
  });

  test('refuses a duration it cannot read, in the same words the dashboard uses', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', 'a while')]));

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('valid duration');
  });

  test('refuses when the module itself is off, rather than opening a pointless hole', async () => {
    const h = harness();

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '20m')]), {
      enabled: false,
    });

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('off in this server');
    expect(h.replyEmbed()?.color).toBe(STATUS_ERROR_COLOUR);
  });

  test('says so when no maintenance store is bound, instead of appearing to work', async () => {
    const h = harness({ omit: ['maintenance'] });

    await h.runCommand(subcommand('maintenance', [stringOption('duration', '20m')]));

    expect(h.replyContent()).toContain('nowhere to store it');
  });
});

describe('/antinuke resume', () => {
  test('ends the window early and re-arms the breaker', async () => {
    const h = harness();
    await h.maintenance.set(WINDOW);

    await h.runCommand(subcommand('resume'), { alertChannelId: ALERT_CHANNEL });

    expect(await h.maintenance.get(GUILD)).toBeNull();
    expect(h.replyContent()).toContain('armed again');
    expect(h.replyEmbed()?.color).toBe(STATUS_SUCCESS_COLOUR);
    expect(h.replyEmbed()?.description).toStartWith(STATUS_SUCCESS_EMOJI);
    expect(h.logged('warn', 'ended Anti-Nuke maintenance mode early')).toBe(true);
  });

  test('says the breaker is already armed rather than pretending to do something', async () => {
    const h = harness();

    await h.runCommand(subcommand('resume'));

    expect(h.replyContent()).toContain('already armed');
    expect(h.replyEmbed()?.color).toBe(STATUS_ERROR_COLOUR);
    expect(h.replyEmbed()?.description).toStartWith(STATUS_ERROR_EMOJI);
  });
});

describe('/antinuke status', () => {
  test('reports every threshold, so nobody has to guess what is being watched', async () => {
    const h = harness();

    await h.runCommand(subcommand('status'));

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('**armed**');
    expect(reply).toContain('Channel deletions: 3 per 30s');
    expect(reply).toContain('Bans or kicks: 5 per 30s');
    expect(reply).toContain('Nothing else is done');

    expect(reply).toContain('No alert channel is set');

    expect(h.replyEmbed()).toBeNull();
  });

  test('reports a live maintenance window, with its expiry and who opened it', async () => {
    const h = harness();
    await h.maintenance.set(WINDOW);

    await h.runCommand(subcommand('status'), { alertChannelId: ALERT_CHANNEL });

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('**paused** for maintenance mode until');
    expect(reply).toContain(ADMIN);
  });

  test('says plainly when the module is off', async () => {
    const h = harness();

    await h.runCommand(subcommand('status'), { enabled: false });

    expect(h.replyContent()).toContain('**off** in this server');
  });
});

interface AckCase {
  name: string;
  raw: RawOption[];
  config?: Partial<AntinukeConfig>;
  options?: HarnessOptions;
  window?: boolean;
}

const MAINTENANCE_20M = subcommand('maintenance', [stringOption('duration', '20m')]);

const ACK_CASES: AckCase[] = [
  { name: 'maintenance opened', raw: MAINTENANCE_20M, config: { alertChannelId: ALERT_CHANNEL } },
  {
    name: 'maintenance longer than the cap',
    raw: subcommand('maintenance', [stringOption('duration', '6h')]),
  },
  {
    name: 'maintenance with an unreadable duration',
    raw: subcommand('maintenance', [stringOption('duration', 'a while')]),
  },
  { name: 'maintenance while the module is off', raw: MAINTENANCE_20M, config: { enabled: false } },
  {
    name: 'maintenance with no store bound',
    raw: MAINTENANCE_20M,
    options: { omit: ['maintenance'] },
  },
  {
    name: 'resume of a live window',
    raw: subcommand('resume'),
    config: { alertChannelId: ALERT_CHANNEL },
    window: true,
  },
  { name: 'resume with nothing to end', raw: subcommand('resume') },
  {
    name: 'resume with no store bound',
    raw: subcommand('resume'),
    options: { omit: ['maintenance'] },
  },
  { name: 'status while armed', raw: subcommand('status') },
  { name: 'status while suspended', raw: subcommand('status'), window: true },
  { name: 'status while the module is off', raw: subcommand('status'), config: { enabled: false } },
];

async function ran(c: AckCase, applicationId?: string | null): Promise<Harness> {
  const h = harness(c.options);
  if (c.window) await h.maintenance.set(WINDOW);

  await h.runCommand(c.raw, c.config, applicationId === undefined ? {} : { applicationId });

  return h;
}

class WatchedStore extends MemoryMaintenanceStore {
  readonly deferredBefore: number[] = [];
  watch: () => number = () => 0;

  override async get(guildId: string): Promise<MaintenanceWindow | null> {
    this.deferredBefore.push(this.watch());
    return super.get(guildId);
  }

  override async set(window: MaintenanceWindow): Promise<void> {
    this.deferredBefore.push(this.watch());
    return super.set(window);
  }

  override async clear(guildId: string): Promise<void> {
    this.deferredBefore.push(this.watch());
    return super.clear(guildId);
  }
}

describe('/antinuke acknowledges each interaction exactly once', () => {
  for (const c of ACK_CASES) {
    test(`${c.name}: one private defer, then the same answer as one private followup`, async () => {
      const h = await ran(c);

      const initial = h.initialCallbacks();
      expect(initial).toHaveLength(1);
      expect(initial[0]?.body).toEqual({ type: 5, data: { flags: EPHEMERAL } });
      expect(h.rest.calls[0]).toBe(initial[0]);

      const followups = h.followups();
      expect(followups).toHaveLength(1);

      const answers = h.answers();
      expect(answers).toHaveLength(1);
      expect(answers[0]?.flags).toBe(EPHEMERAL);
      expect(h.replyContent()).not.toBeNull();

      const replied = await ran(c, null);
      expect(answers[0]).toEqual(replied.answers()[0]);
    });
  }

  for (const [name, raw, window] of [
    ['maintenance', MAINTENANCE_20M, false],
    ['resume', subcommand('resume'), true],
    ['status', subcommand('status'), true],
  ] as const) {
    test(`/antinuke ${name} defers before it touches the maintenance store`, async () => {
      const store = new WatchedStore();
      const h = harness({ maintenance: store });
      if (window) await store.set(WINDOW);
      store.deferredBefore.length = 0;
      store.watch = () => h.initialCallbacks().length;

      await h.runCommand(raw);

      expect(store.deferredBefore.length).toBeGreaterThan(0);
      expect(store.deferredBefore.every((sent) => sent === 1)).toBe(true);
    });
  }

  test('without an application id there is no defer, and the one callback is the answer', async () => {
    const h = harness();

    await h.runCommand(subcommand('status'), {}, { applicationId: null });

    const initial = h.initialCallbacks();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.path).toEndWith(`/${INTERACTION_TOKEN}/callback`);
    expect((initial[0]?.body as CallbackBody | undefined)?.type).toBe(4);
    expect(h.followups()).toHaveLength(0);

    expect(h.answers()).toHaveLength(1);
    expect(h.answers()[0]?.flags).toBe(EPHEMERAL);
    expect(h.replyContent()).toContain('**armed**');
  });

  test('a redelivered /antinuke acknowledges and answers once', async () => {
    const h = harness();

    await h.runCommand(subcommand('status'), {}, { idempotencyKey: 'interaction-1' });
    await h.runCommand(subcommand('status'), {}, { idempotencyKey: 'interaction-1' });

    expect(h.initialCallbacks()).toHaveLength(1);
    expect(h.followups()).toHaveLength(1);
  });
});
