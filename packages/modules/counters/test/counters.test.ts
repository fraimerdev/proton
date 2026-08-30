import { describe, expect, test } from 'bun:test';
import { ModuleRegistry, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { MODULE_ID, REFRESH_INTERVAL_MS } from '../src/config.ts';
import { createCountersModule } from '../src/index.ts';
import { REFRESH_JOB, REFRESH_KEY } from '../src/refresh.ts';
import {
  BOT_PERMISSIONS,
  COUNTER_A,
  COUNTER_B,
  CREATED,
  GUILD,
  harness,
  MEMBER_COUNT,
  NO_CACHED_STATE,
  protonEvent,
  subcommand,
} from './harness.ts';

const MEMBERS = {
  id: COUNTER_A,
  channelId: COUNTER_A,
  template: 'Members: {count}',
  source: 'members',
} as const;
const ROLES = {
  id: COUNTER_B,
  channelId: COUNTER_B,
  template: 'Roles: {count}',
  source: 'roles',
} as const;

const OWNED = { id: 'members', template: 'Members: {count}', source: 'members' } as const;

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
    expect(h.replyContent()).toContain('nowhere to come from');
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

describe('a counter Proton makes the channel for', () => {
  test('makes a voice channel at the top of the list and records which one it is', async () => {
    const h = harness();

    await h.refresh({ config: { counters: [OWNED] } });

    expect(h.creates()).toHaveLength(1);
    expect(h.creates()[0]?.path).toBe(`/guilds/${GUILD}/channels`);
    expect(h.creates()[0]?.body).toEqual({
      name: `Members: ${MEMBER_COUNT}`,
      type: 2,
      position: 0,
    });

    expect(h.owned.rows.get(OWNED.id)).toBe(CREATED);
  });

  test('is born showing the number, so it is never renamed straight afterwards', async () => {
    const h = harness();

    await h.refresh({ config: { counters: [OWNED] } });

    expect(h.patches()).toHaveLength(0);
  });

  test('stops members joining it, which is what makes it a sign rather than a room', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS | Permissions.ManageRoles });

    await h.refresh({ config: { counters: [OWNED] } });

    expect(h.overwrites()).toHaveLength(1);
    expect(h.overwrites()[0]?.path).toBe(`/channels/${CREATED}/permissions/${GUILD}`);
    expect(h.overwrites()[0]?.body).toEqual({
      type: 0,
      allow: '0',
      deny: String(Permissions.Connect),
    });
  });

  test('renames the channel it already made instead of making a second one', async () => {
    const h = harness();
    h.owned.rows.set(OWNED.id, COUNTER_A);

    await h.refresh({ config: { counters: [OWNED] } });

    expect(h.creates()).toHaveLength(0);
    expect(h.patches()).toHaveLength(1);
    expect(h.patches()[0]?.path).toBe(`/channels/${COUNTER_A}`);
  });

  test('records nothing and says why when Discord refuses to make it', async () => {
    const h = harness();
    h.rest.createResponse = { status: 403, body: { message: 'Missing Permissions' } };

    await h.run(refreshSubcommand, { config: { counters: [OWNED] } });

    expect(h.owned.rows.size).toBe(0);
    expect(h.replyContent()).toContain('could not make the channel');
    expect(h.replyContent()).toContain(`Members: ${MEMBER_COUNT}`);
  });

  test('counts a channel it could not lock as made, and says it is not locked', async () => {
    // The harness bot has no Manage Roles, which is exactly what refuses the lock.
    const h = harness();

    await h.run(refreshSubcommand, { config: { counters: [OWNED] } });

    expect(h.owned.rows.get(OWNED.id)).toBe(CREATED);
    expect(h.replyContent()).toContain('1 created');
    expect(h.replyContent()).toContain('Manage Roles');
  });

  test('refuses to make one when the deployment cannot record it, and still refreshes the rest', async () => {
    const h = harness();

    await h.run(refreshSubcommand, {
      config: { counters: [MEMBERS, OWNED] },
      deps: { guildState: h.stateStore },
    });

    expect(h.creates()).toHaveLength(0);
    expect(h.patches()).toHaveLength(1);
    expect(h.replyContent()).toContain('nowhere to record');
  });

  test('leaves every counter alone rather than duplicating when the record cannot be read', async () => {
    const h = harness();
    h.owned.failOn = 'list';

    await h.run(refreshSubcommand, { config: { counters: [MEMBERS, OWNED] } });

    expect(h.creates()).toHaveLength(0);
    expect(h.patches()).toHaveLength(0);
    expect(h.replyContent()).toContain('duplicates');
  });

  test('says so, and records nothing, when it made the channel but could not file it', async () => {
    const h = harness();
    h.owned.failOn = 'attach';

    await h.run(refreshSubcommand, { config: { counters: [OWNED] } });

    expect(h.creates()).toHaveLength(1);
    expect(h.owned.rows.size).toBe(0);
    expect(h.replyContent()).toContain('could not record it');
  });

  test('refuses to make a second channel for a counter whose first was never filed', async () => {
    const h = harness();
    h.owned.failOn = 'attach';

    await h.refresh({ config: { counters: [OWNED] } });

    h.owned.failOn = null;
    await h.run(refreshSubcommand, { config: { counters: [OWNED] } });

    expect(h.creates()).toHaveLength(1);
    expect(h.replyContent()).toContain('stray counter channel');
  });

  test('does not make the channel until it knows the number to put on it', async () => {
    const h = harness();
    delete h.state.memberCount;

    await h.refresh({ config: { counters: [OWNED] } });

    expect(h.creates()).toHaveLength(0);
    expect(h.owned.rows.size).toBe(0);
  });

  test('forgets a counter that was deleted, and leaves its channel where it is', async () => {
    const h = harness();
    h.owned.rows.set('gone', CREATED);

    await h.refresh({ config: { counters: [MEMBERS] } });

    expect(h.owned.rows.has('gone')).toBe(false);
    expect(h.calls().some((call) => call.method === 'DELETE')).toBe(false);
    expect(h.logs.some((line) => line.message.includes(CREATED))).toBe(true);
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
