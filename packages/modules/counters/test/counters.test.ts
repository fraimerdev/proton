import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { MODULE_ID, REFRESH_INTERVAL_MS } from '../src/config.ts';
import { createCountersModule } from '../src/index.ts';
import { REFRESH_JOB, REFRESH_KEY } from '../src/refresh.ts';
import {
  COUNTER_A,
  COUNTER_B,
  harness,
  MEMBER_COUNT,
  NO_CACHED_STATE,
  protonEvent,
  subcommand,
} from './harness.ts';

const MEMBERS = { channelId: COUNTER_A, template: 'Members: {count}', source: 'members' } as const;
const ROLES = { channelId: COUNTER_B, template: 'Roles: {count}', source: 'roles' } as const;

const refreshSubcommand = subcommand('refresh');

describe('/counters refresh', () => {
  test('renames a counter whose number has moved with one PATCH carrying only the name', async () => {
    const h = harness();

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] } });

    expect(h.patches()).toHaveLength(1);
    expect(h.patches()[0]?.path).toBe(`/channels/${COUNTER_A}`);
    expect(h.patches()[0]?.body).toEqual({ name: `Members: ${MEMBER_COUNT}` });
  });

  test('issues nothing for a counter already showing the right name', async () => {
    const h = harness();
    h.state.channels.set(COUNTER_A, {
      id: COUNTER_A,
      parentId: null,
      type: 2,
      name: `Members: ${MEMBER_COUNT}`,
      overwrites: [],
    });

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] } });

    expect(h.patches()).toHaveLength(0);
    expect(h.replyContent()).toContain('1 already correct');
  });

  test('reports the skips alongside the changes', async () => {
    const h = harness();
    h.state.channels.set(COUNTER_B, {
      id: COUNTER_B,
      parentId: null,
      type: 2,
      name: `Roles: ${h.state.roles.size - 1}`,
      overwrites: [],
    });

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS, ROLES] } });

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('2 counter channels');
    expect(reply).toContain('1 renamed');
    expect(reply).toContain('1 already correct');
  });

  test('names ManageChannels when the bot cannot rename the channel', async () => {
    const h = harness({ botPermissions: Permissions.ViewChannel | Permissions.SendMessages });

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] } });

    expect(h.patches()).toHaveLength(0);

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('Manage Channels');
    expect(reply).toContain(`<#${COUNTER_A}>`);
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('Manage Channels')),
    ).toBe(true);
  });

  test('says a counter reading an uncached member count was left alone', async () => {
    const h = harness();
    delete h.state.memberCount;

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] } });

    expect(h.patches()).toHaveLength(0);
    expect(h.replyContent()).toContain('1 skipped');
  });

  test('points an admin at the dashboard when nothing is configured', async () => {
    const h = harness();

    await h.run(refreshSubcommand, { config: { counters: [] } });

    expect(h.replyContent()).toContain('No counter channels are set up');
    expect(h.patches()).toHaveLength(0);
  });

  test('says the server’s channels are not cached yet rather than renaming blind', async () => {
    const h = harness();

    await h.run(refreshSubcommand, {
      config: { counters: [MEMBERS] },
      deps: { guildState: NO_CACHED_STATE },
    });

    expect(h.patches()).toHaveLength(0);
    expect(h.replyContent()).toContain("don't have this server's channel list cached");
  });

  test('names the missing wiring when guild state was never bound', async () => {
    const h = harness({ deps: {} });

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] } });

    expect(h.patches()).toHaveLength(0);
    expect(h.replyContent()).toContain("isn't fully wired up");
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('guildState')),
    ).toBe(true);
  });

  test('renaming a counter is not a moderation case', async () => {
    const h = harness();

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] } });

    expect(h.recorder.recorded).toHaveLength(0);
  });

  test('the same invocation replayed renames the channel once', async () => {
    const h = harness();
    const idempotencyKey = 'interaction-1';

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] }, idempotencyKey });
    await h.run(refreshSubcommand, { config: { counters: [MEMBERS] }, idempotencyKey });

    expect(h.patches()).toHaveLength(1);
  });
});

describe('the refresh loop', () => {
  test('renames what changed and books the next run ten minutes later', async () => {
    const h = harness();
    const before = Date.now();

    await h.refresh({ config: { counters: [MEMBERS] } });

    expect(h.patches()).toHaveLength(1);
    expect(h.scheduler.booked).toHaveLength(1);

    const booked = h.scheduler.booked[0];
    expect(booked?.jobId).toBe(REFRESH_JOB);
    expect(booked?.naturalKey).toBe(REFRESH_KEY);
    expect(booked?.options).toEqual({ replace: true });
    expect(booked?.runAt.getTime()).toBeGreaterThanOrEqual(before + REFRESH_INTERVAL_MS);
  });

  test('a switched-off module stops instead of rescheduling', async () => {
    const h = harness();

    await h.refresh({ config: { enabled: false, counters: [MEMBERS] } });

    expect(h.scheduler.booked).toHaveLength(0);
    expect(h.patches()).toHaveLength(0);
  });

  test('a module with no counters left stops instead of rescheduling', async () => {
    const h = harness();

    await h.refresh({ config: { counters: [] } });

    expect(h.scheduler.booked).toHaveLength(0);
  });

  test('keeps running when a refresh finds no cached state for the server', async () => {
    const h = harness();

    await h.refresh({
      config: { counters: [MEMBERS] },
      deps: { guildState: NO_CACHED_STATE },
    });

    expect(h.patches()).toHaveLength(0);
    expect(h.scheduler.booked).toHaveLength(1);
  });

  test('stops rather than logging the same wiring error every ten minutes', async () => {
    const h = harness({ deps: {} });

    await h.refresh({ config: { counters: [MEMBERS] } });

    expect(h.scheduler.booked).toHaveLength(0);
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('guildState')),
    ).toBe(true);
  });

  test('says so rather than crashing when the deployment has no scheduler', async () => {
    const h = harness();

    await h.refresh({ config: { counters: [MEMBERS] }, scheduler: false });

    expect(h.patches()).toHaveLength(1);
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('/counters refresh')),
    ).toBe(true);
  });
});

describe('the schedule listener', () => {
  test('books a refresh when the server becomes available', async () => {
    const h = harness();

    await h.listen(protonEvent('guild.available', {}), { config: { counters: [MEMBERS] } });

    expect(h.scheduler.booked).toHaveLength(1);
    expect(h.scheduler.booked[0]?.naturalKey).toBe(REFRESH_KEY);
  });

  test('leaves a pending refresh where it is on reconnect', async () => {
    const h = harness();

    await h.listen(protonEvent('guild.available', {}), { config: { counters: [MEMBERS] } });

    expect(h.scheduler.booked[0]?.options).toEqual({ replace: false });
  });

  test('moves the refresh to now when an admin saves the settings', async () => {
    const h = harness();

    await h.listen(protonEvent('proton.config_changed', { moduleId: MODULE_ID }), {
      config: { counters: [MEMBERS] },
    });

    expect(h.scheduler.booked[0]?.options).toEqual({ replace: true });
  });

  test('ignores another module’s config change', async () => {
    const h = harness();

    await h.listen(protonEvent('proton.config_changed', { moduleId: 'tags' }), {
      config: { counters: [MEMBERS] },
    });

    expect(h.scheduler.booked).toHaveLength(0);
    expect(h.scheduler.cancelled).toHaveLength(0);
  });

  test('cancels the refresh when the module is switched off in the dashboard', async () => {
    const h = harness();

    await h.listen(
      protonEvent('proton.config_changed', { moduleId: MODULE_ID, enabledAfter: false }),
      { config: { counters: [MEMBERS] } },
    );

    expect(h.scheduler.booked).toHaveLength(0);
    expect(h.scheduler.cancelled).toEqual([{ jobId: REFRESH_JOB, naturalKey: REFRESH_KEY }]);
  });

  test('cancels the refresh when the last counter is removed', async () => {
    const h = harness();

    await h.listen(protonEvent('proton.config_changed', { moduleId: MODULE_ID }), {
      config: { counters: [] },
    });

    expect(h.scheduler.cancelled).toHaveLength(1);
  });

  test('says the counters will never refresh when there is no scheduler to book them', async () => {
    const h = harness();

    await h.listen(protonEvent('guild.available', {}), {
      config: { counters: [MEMBERS] },
      scheduler: false,
    });

    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('never refresh')),
    ).toBe(true);
  });
});

describe('the counters manifest', () => {
  function registered(): ModuleRegistry {
    const registry = new ModuleRegistry();
    registry.register(createCountersModule());
    return registry;
  }

  test('registers, so every rule the registry enforces holds', () => {
    expect(() => registered()).not.toThrow();
  });

  test('declares every action kind its code paths execute', () => {
    const registry = registered();

    expect(registry.mayExecute(MODULE_ID, 'interaction_reply')).toBe(true);
    expect(registry.mayExecute(MODULE_ID, 'edit_channel')).toBe(true);
  });

  test('declares the durable schedule its listener books', () => {
    expect(registered().maySchedule(MODULE_ID, REFRESH_JOB)).toBe(true);
  });

  test('asks the invite for the permission a rename needs', () => {
    expect(registered().invitePermissions() & Permissions.ManageChannels).toBe(
      Permissions.ManageChannels,
    );
  });

  test('needs no intent beyond Guilds', () => {
    expect(registered().requiredIntents()).toBe(GatewayIntentBits.Guilds);
  });

  test('every dashboard field is a real config key', () => {
    const manifest = createCountersModule();
    const keys = new Set(Object.keys(manifest.configSchema.shape));

    for (const section of manifest.dashboard?.sections ?? []) {
      for (const field of section.fields) expect(keys.has(field)).toBe(true);
    }
  });

  test('caps the counter list against the guild’s tier where the save happens', () => {
    expect(createCountersModule().configLimits).toEqual([{ key: 'counters', path: 'counters' }]);
  });
});
