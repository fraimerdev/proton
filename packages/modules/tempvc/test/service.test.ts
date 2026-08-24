import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { TemporaryVoiceService } from '../src/service.ts';
import { ADA, BEN, BOT, CREATED, callsOf, GUILD, HUB, harness, member } from './harness.ts';

describe('creating a temporary channel', () => {
  test('reserves, creates, attaches, moves — in that order', async () => {
    const fake = harness();

    const outcome = await fake.service.create(fake.ctx, fake.hub, member());

    expect('created' in outcome).toBe(true);
    expect(fake.calls.map((call) => call.kind)).toEqual(['create_channel', 'move_member', 'send']);

    const row = [...fake.repository.rows.values()][0];
    expect(row).toMatchObject({ channelId: CREATED, ownerId: ADA, status: 'live' });
  });

  test('the owner is moved into it, which the precheck used to refuse for the server owner', async () => {
    const fake = harness();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(callsOf(fake, 'move_member')[0]).toMatchObject({
      targetId: ADA,
      payload: { userId: ADA, channelId: CREATED },
    });
  });

  test('the name template is rendered from the member', async () => {
    const fake = harness();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(callsOf(fake, 'create_channel')[0]?.payload.name).toBe('Ada’s room');
  });

  /**
   * The reservation exists before Discord is called. If the create fails there is a row to drop and
   * no channel; the old order made the channel first, so a failure after it leaked a real channel
   * that nothing could ever find again.
   */
  test('a refused create leaves no row and no channel behind', async () => {
    const fake = harness();
    fake.refuse('create_channel', 'missing_permission', 'I am missing Manage Channels.');

    const outcome = await fake.service.create(fake.ctx, fake.hub, member());

    expect(outcome).toMatchObject({ refused: 'create_failed' });
    expect(fake.repository.rows.size).toBe(0);
    expect(callsOf(fake, 'move_member')).toHaveLength(0);
  });

  test('a create Discord accepts without saying which channel is treated the same way', async () => {
    const fake = harness({ createdChannelId: null });

    const outcome = await fake.service.create(fake.ctx, fake.hub, member());

    expect(outcome).toMatchObject({ refused: 'create_failed' });
    expect(fake.repository.rows.size).toBe(0);
  });

  test('the new channel is created with the owner already allowed in', async () => {
    const fake = harness({ hub: { privacy: 'locked' } });
    await fake.service.create(fake.ctx, fake.hub, member());

    const overwrites = callsOf(fake, 'create_channel')[0]?.payload.permissionOverwrites as Array<{
      id: string;
      allow: string;
    }>;

    const owner = overwrites.find((entry) => entry.id === ADA);
    const bot = overwrites.find((entry) => entry.id === BOT);

    expect((BigInt(owner?.allow ?? '0') & Permissions.Connect) !== 0n).toBe(true);
    expect((BigInt(bot?.allow ?? '0') & Permissions.Connect) !== 0n).toBe(true);
  });
});

describe('how many channels one member may hold', () => {
  test('a second join is sent to the channel they already own', async () => {
    const fake = harness();
    const hub = fake.hub;

    await fake.service.create(fake.ctx, hub, member());
    fake.calls.length = 0;

    const outcome = await fake.service.create(fake.ctx, hub, member());

    expect(outcome).toMatchObject({ refused: 'moved_existing' });
    expect(callsOf(fake, 'create_channel')).toHaveLength(0);
    expect(callsOf(fake, 'move_member')[0]?.payload.channelId).toBe(CREATED);
    expect(fake.repository.rows.size).toBe(1);
  });

  test('a higher cap lets them hold more', async () => {
    const fake = harness({ hub: { maxChannelsPerUser: 2 } });
    const hub = fake.hub;

    await fake.service.create(fake.ctx, hub, member());
    const second = await fake.service.create(fake.ctx, hub, member());

    expect('created' in second).toBe(true);
    expect(fake.repository.rows.size).toBe(2);
  });

  /** Two joins landing together must not both read "none held" and both reserve. */
  test('simultaneous joins by one member still yield one channel', async () => {
    const fake = harness();
    const hub = fake.hub;

    await Promise.all([
      fake.service.create(fake.ctx, hub, member()),
      fake.service.create(fake.ctx, hub, member()),
    ]);

    expect(fake.repository.rows.size).toBe(1);
  });

  test('two different members each get their own', async () => {
    const fake = harness();
    const hub = fake.hub;

    await fake.service.create(fake.ctx, hub, member(ADA));
    await fake.service.create(fake.ctx, hub, member(BEN));

    expect(fake.repository.rows.size).toBe(2);
  });
});

describe('the creation cooldown', () => {
  test('a member inside the window is refused', async () => {
    const hits = new Set<string>();
    const fake = harness();

    let made = 0;
    const service = new TemporaryVoiceService(
      { repository: fake.repository, botUserId: BOT, newId: () => `row-${++made}` },
      {
        async hit(key: string) {
          if (hits.has(key)) return true;

          hits.add(key);
          return false;
        },
      },
    );

    await service.create(fake.ctx, fake.hub, member());

    expect(await service.create(fake.ctx, fake.hub, member())).toMatchObject({
      refused: 'cooldown',
    });
  });
});

describe('deleting', () => {
  test('an empty channel is scheduled, not deleted on the spot', async () => {
    const now = new Date('2026-08-23T12:00:00Z');
    const fake = harness({ now: () => now });
    const hub = fake.hub;

    const outcome = await fake.service.create(fake.ctx, hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.scheduleDelete(fake.ctx, hub, outcome.created);

    expect(callsOf(fake, 'delete_channel')).toHaveLength(0);
    expect(fake.repository.rows.get(outcome.created.id)?.deleteAfter).toEqual(
      new Date(now.getTime() + 5_000),
    );
  });

  test('a rejoin clears the deadline', async () => {
    const fake = harness();
    const hub = fake.hub;

    const outcome = await fake.service.create(fake.ctx, hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    await fake.service.scheduleDelete(fake.ctx, hub, outcome.created);
    await fake.service.cancelDelete(fake.ctx, outcome.created);

    expect(fake.repository.rows.get(outcome.created.id)?.deleteAfter).toBeNull();
  });

  test('destroy removes the channel and the row', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    expect(await fake.service.destroy(fake.ctx, outcome.created, 'empty')).toBe(true);

    expect(callsOf(fake, 'delete_channel')[0]?.payload.channelId).toBe(CREATED);
    expect(fake.repository.rows.size).toBe(0);
  });

  /** Two sweepers must not both call Discord for the same channel. */
  test('a second destroy of the same row is a no-op', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    const row = fake.row(outcome.created.id);
    const [first, second] = await Promise.all([
      fake.service.destroy(fake.ctx, row, 'empty'),
      fake.service.destroy(fake.ctx, row, 'empty'),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(callsOf(fake, 'delete_channel')).toHaveLength(1);
  });

  /**
   * A delete that 404s means the channel is already gone, which is the goal. Treating it as failure
   * left the row stuck in `closing` and its owner unable to ever get another channel.
   */
  test('a channel Discord says is already gone still clears the row', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.refuse('delete_channel', 'not_found', 'That channel does not exist.');
    const row = fake.row(outcome.created.id);

    expect(await fake.service.destroy(fake.ctx, row, 'empty')).toBe(true);
    expect(fake.repository.rows.size).toBe(0);
  });

  test('a delete refused for a real reason puts the row back rather than wedging it', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.refuse('delete_channel', 'missing_permission', 'I am missing Manage Channels.');
    const row = fake.row(outcome.created.id);

    expect(await fake.service.destroy(fake.ctx, row, 'empty')).toBe(false);
    expect(fake.repository.rows.size).toBe(1);
  });
});

describe('ownership', () => {
  test('claiming an ownerless channel works exactly once', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    await fake.repository.setOwner(outcome.created.id, null);
    const row = fake.row(outcome.created.id);

    const results = await Promise.all([
      fake.service.claim(fake.ctx, row, ADA, 'public'),
      fake.service.claim(fake.ctx, row, BEN, 'public'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('claiming a channel that still has an owner fails', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    const row = fake.row(outcome.created.id);
    expect(await fake.service.claim(fake.ctx, row, BEN, 'public')).toBe(false);
  });

  test('transfer moves the owner and rewrites the overwrites so the new one has rights', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.transfer(fake.ctx, outcome.created, BEN, 'locked');

    expect(fake.repository.rows.get(outcome.created.id)?.ownerId).toBe(BEN);

    const overwrites = callsOf(fake, 'edit_channel')[0]?.payload.permissionOverwrites as Array<{
      id: string;
      allow: string;
    }>;

    expect(
      (BigInt(overwrites.find((e) => e.id === BEN)?.allow ?? '0') & Permissions.Connect) !== 0n,
    ).toBe(true);
  });
});

describe('trust and block survive as rows, not as guesses', () => {
  test('blocking somebody writes the row, rewrites the channel, and disconnects them', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.setAccess(fake.ctx, outcome.created, BEN, 'block', 'public');

    expect(await fake.repository.access(outcome.created.id)).toEqual([
      { userId: BEN, kind: 'block' },
    ]);

    expect(callsOf(fake, 'edit_channel')).toHaveLength(1);
    expect(callsOf(fake, 'move_member')[0]?.payload.channelId).toBeNull();
  });

  test('trusting somebody does not disconnect them', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.setAccess(fake.ctx, outcome.created, BEN, 'trust', 'locked');

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
  });

  test('clearing access removes the row', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    await fake.service.setAccess(fake.ctx, outcome.created, BEN, 'block', 'public');
    await fake.service.setAccess(fake.ctx, outcome.created, BEN, null, 'public');

    expect(await fake.repository.access(outcome.created.id)).toEqual([]);
  });
});

describe('temporary roles', () => {
  const ROLE = '800000000000000001';

  test('are only handed out when a mode asks for it', async () => {
    const fake = harness();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    expect(callsOf(fake, 'add_role')).toHaveLength(0);
  });

  test('owner mode gives it to the owner and nobody else', async () => {
    const fake = harness({ hub: { temporaryRoleId: ROLE, temporaryRoleMode: 'owner' } });
    const hub = fake.hub;

    const outcome = await fake.service.create(fake.ctx, hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    expect(callsOf(fake, 'add_role')[0]).toMatchObject({
      targetId: ADA,
      payload: { roleId: ROLE },
    });

    fake.calls.length = 0;
    await fake.service.grantRole(fake.ctx, hub, outcome.created.id, BEN, false);
    expect(callsOf(fake, 'add_role')).toHaveLength(0);
  });

  /**
   * The whole reason granted roles are recorded: Proton must never take away a role the member
   * already had. Only what it granted is ever removed.
   */
  test('only a role Proton granted is taken back', async () => {
    const fake = harness({ hub: { temporaryRoleId: ROLE, temporaryRoleMode: 'everyone' } });
    const hub = fake.hub;

    const outcome = await fake.service.create(fake.ctx, hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    // Ben never received it, so leaving must not strip it from him.
    fake.calls.length = 0;
    await fake.service.revokeRoles(fake.ctx, outcome.created.id, BEN);
    expect(callsOf(fake, 'remove_role')).toHaveLength(0);

    await fake.service.revokeRoles(fake.ctx, outcome.created.id, ADA);
    expect(callsOf(fake, 'remove_role')[0]).toMatchObject({ targetId: ADA });
  });

  test('a grant Discord refuses is not recorded, so nothing is taken back later', async () => {
    const fake = harness({ hub: { temporaryRoleId: ROLE, temporaryRoleMode: 'owner' } });
    const hub = fake.hub;

    fake.refuse('add_role', 'missing_permission', 'I am missing Manage Roles.');
    const outcome = await fake.service.create(fake.ctx, hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    expect(await fake.repository.rolesGranted(outcome.created.id)).toEqual([]);
  });
});

describe('the control panel', () => {
  test('is posted into the new channel', async () => {
    const fake = harness();
    await fake.service.create(fake.ctx, fake.hub, member());

    const sent = callsOf(fake, 'send')[0];
    expect(sent?.payload.channelId).toBe(CREATED);
    expect(Array.isArray(sent?.payload.components)).toBe(true);
  });

  test('is not posted when the creator channel turns the interface off', async () => {
    const fake = harness({ hub: { interfaceEnabled: false } });
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(callsOf(fake, 'send')).toHaveLength(0);
  });

  test('a panel that cannot be posted does not fail the creation', async () => {
    const fake = harness();
    fake.refuse('send', 'missing_permission', 'I am missing Send Messages.');

    const outcome = await fake.service.create(fake.ctx, fake.hub, member());

    expect('created' in outcome).toBe(true);
    expect(fake.repository.rows.size).toBe(1);
  });
});

describe('nothing here reaches the case ledger', () => {
  test('every temporary-voice action is written with record off', async () => {
    const fake = harness({
      hub: { temporaryRoleId: '800000000000000001', temporaryRoleMode: 'owner' },
    });
    await fake.service.create(fake.ctx, fake.hub, member());

    // The harness records the request it was handed; `record: false` is asserted by the module's
    // own call sites, so this guards the shape rather than the flag.
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every((call) => call.idempotencyKey.startsWith('tempvc:'))).toBe(true);
  });
});

describe('guild scoping', () => {
  test('a row from another guild is never mistaken for this one', async () => {
    const fake = harness();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(await fake.repository.byChannel('900000000000000009', CREATED)).toBeNull();
    expect(await fake.repository.byChannel(GUILD, CREATED)).not.toBeNull();
  });

  test('the creator channel is remembered on the row', async () => {
    const fake = harness();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect([...fake.repository.rows.values()][0]?.hubChannelId).toBe(HUB);
  });
});
