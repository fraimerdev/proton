import { describe, expect, test } from 'bun:test';
import { encodeCustomId, type ProtonEvent } from '@proton/core';
import { MODULE_ID } from '../src/config.ts';
import { handleComponent, handleModal } from '../src/interactions.ts';
import { MODAL_ACTION, PANEL_ACTION, USER_SELECT_ACTION } from '../src/interface.ts';
import { ADA, BEN, callsOf, GUILD, harness, member } from './harness.ts';

const COMPONENT = 3;
const MODAL_SUBMIT = 5;

function customId(action: string, ...args: string[]): string {
  const encoded = encodeCustomId(MODULE_ID, action, ...args);
  if (!encoded.ok) throw new Error('custom id too long');

  return encoded.customId;
}

function press(id: string, userId = ADA, values: string[] = []): ProtonEvent {
  return {
    id: `evt-${id}-${userId}`,
    type: 'interaction.component',
    guildId: GUILD,
    payload: {
      id: '111111111111111111',
      token: 'tok',
      type: COMPONENT,
      application_id: '222222222222222222',
      guild_id: GUILD,
      channel_id: '600000000000000001',
      member: { user: { id: userId } },
      data: { custom_id: id, component_type: 2, values },
    },
  } as unknown as ProtonEvent;
}

function submit(id: string, fields: Record<string, string>, userId = ADA): ProtonEvent {
  return {
    id: `evt-modal-${userId}`,
    type: 'interaction.modal',
    guildId: GUILD,
    payload: {
      id: '111111111111111111',
      token: 'tok',
      type: MODAL_SUBMIT,
      application_id: '222222222222222222',
      guild_id: GUILD,
      member: { user: { id: userId } },
      data: {
        custom_id: id,
        components: Object.entries(fields).map(([key, value]) => ({
          type: 1,
          components: [{ type: 4, custom_id: key, value }],
        })),
      },
    },
  } as unknown as ProtonEvent;
}

async function withChannel(options: Parameters<typeof harness>[0] = {}) {
  const fake = harness(options);
  const outcome = await fake.service.create(fake.ctx, fake.hub, member());
  if (!('created' in outcome)) throw new Error('expected a channel');

  const deps = {
    repository: fake.repository,
    presence: presence(),
    botUserId: '300000000000000000',
  };
  fake.calls.length = 0;

  return { fake, row: outcome.created, deps };
}

function presence() {
  return {
    locate: async () => null,
    place: async () => undefined,
    enter: async () => 1,
    leave: async () => 0,
    occupants: async () => [],
    reset: async () => undefined,
  };
}

describe('a button press is authorised from the database, never from the button', () => {
  test('the owner may use their own controls', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'delete', row.id)),
      fake.ctx,
      deps,
    );

    expect(outcome).toMatchObject({ action: 'done', what: 'delete' });
  });

  /** The panel sits in a channel anybody in it can see, so a stranger can press every button. */
  test('somebody who is not the owner is refused', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'delete', row.id), BEN),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
    expect(callsOf(fake, 'delete_channel')).toHaveLength(0);
  });

  /** A panel message outlives the settings that made it. */
  test('a control the admin has since switched off is refused', async () => {
    const { fake, row, deps } = await withChannel();
    fake.ctx.config.hubs[0] = { ...fake.hub, allow: { ...fake.hub.allow, delete: false } };

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'delete', row.id)),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
    expect(callsOf(fake, 'delete_channel')).toHaveLength(0);
  });

  test('a panel left over from a deleted channel says so instead of throwing', async () => {
    const { fake, deps } = await withChannel();

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'delete', 'row-does-not-exist')),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
  });

  test('a component from another module is ignored, not answered', async () => {
    const { fake, deps } = await withChannel();

    expect((await handleComponent(press('proton:rolemenu:toggle:1'), fake.ctx, deps)).action).toBe(
      'ignored',
    );
  });

  test('turning member control off in settings disables every button', async () => {
    const { fake, row, deps } = await withChannel();
    fake.ctx.config.ownerCommands = false;

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'delete', row.id)),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
  });
});

describe('claim is the one control a non-owner may press', () => {
  test('a member inside an ownerless channel can take it', async () => {
    const { fake, row, deps } = await withChannel();
    await fake.repository.setOwner(row.id, null);

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'claim', row.id), BEN),
      fake.ctx,
      deps,
    );

    expect(outcome).toMatchObject({ action: 'done', what: 'claim' });
    expect(fake.row(row.id).ownerId).toBe(BEN);
  });

  test('a channel that still has an owner cannot be claimed', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleComponent(
      press(customId(PANEL_ACTION, 'claim', row.id), BEN),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
    expect(fake.row(row.id).ownerId).toBe(ADA);
  });
});

describe('the member picker', () => {
  test('blocking through the panel writes the row and rewrites the channel', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleComponent(
      press(customId(USER_SELECT_ACTION, 'block', row.id), ADA, [BEN]),
      fake.ctx,
      deps,
    );

    expect(outcome).toMatchObject({ action: 'done', what: 'block' });
    expect(await fake.repository.access(row.id)).toEqual([{ userId: BEN, kind: 'block' }]);
    expect(callsOf(fake, 'edit_channel')).toHaveLength(1);
  });

  test('picking yourself is refused rather than acted on', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleComponent(
      press(customId(USER_SELECT_ACTION, 'kick', row.id), ADA, [ADA]),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
  });

  test('transfer through the panel moves ownership', async () => {
    const { fake, row, deps } = await withChannel();

    await handleComponent(
      press(customId(USER_SELECT_ACTION, 'transfer', row.id), ADA, [BEN]),
      fake.ctx,
      deps,
    );

    expect(fake.row(row.id).ownerId).toBe(BEN);
  });
});

describe('modals', () => {
  test('a rename applies the typed name', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleModal(
      submit(customId(MODAL_ACTION, 'rename', row.id), { name: 'Study room' }),
      fake.ctx,
      deps,
    );

    expect(outcome).toMatchObject({ action: 'done', what: 'rename' });
    expect(callsOf(fake, 'edit_channel')[0]?.payload.name).toBe('Study room');
  });

  test('an empty name is refused rather than sent to Discord', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleModal(
      submit(customId(MODAL_ACTION, 'rename', row.id), { name: '   ' }),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
    expect(callsOf(fake, 'edit_channel')).toHaveLength(0);
  });

  test('a limit outside what Discord accepts is refused with the number named', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleModal(
      submit(customId(MODAL_ACTION, 'limit', row.id), { limit: '900' }),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
    expect(callsOf(fake, 'edit_channel')).toHaveLength(0);
  });

  test('a valid limit is applied', async () => {
    const { fake, row, deps } = await withChannel();

    await handleModal(
      submit(customId(MODAL_ACTION, 'limit', row.id), { limit: '4' }),
      fake.ctx,
      deps,
    );

    expect(callsOf(fake, 'edit_channel')[0]?.payload.userLimit).toBe(4);
  });

  test('a modal submitted by somebody who is not the owner changes nothing', async () => {
    const { fake, row, deps } = await withChannel();

    const outcome = await handleModal(
      submit(customId(MODAL_ACTION, 'rename', row.id), { name: 'Mine now' }, BEN),
      fake.ctx,
      deps,
    );

    expect(outcome.action).toBe('refused');
    expect(callsOf(fake, 'edit_channel')).toHaveLength(0);
  });
});
