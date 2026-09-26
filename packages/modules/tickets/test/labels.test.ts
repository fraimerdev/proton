import { describe, expect, test } from 'bun:test';
import { encodeCustomId, formatCommandLabel } from '@proton/core';
import { mayOpen } from '../src/lifecycle.ts';
import {
  GUILD,
  harness,
  integerOption,
  MEMBER,
  MOD,
  PANEL,
  PANEL_CHANNEL,
  pressEvent,
  subcommand,
  TYPE,
} from './harness.ts';

const RENAMED = (key: string, path?: string) =>
  formatCommandLabel(key, path, key === 'ticket' ? 'support' : undefined);

const OPEN_PRESS = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
const OPEN = OPEN_PRESS.ok ? OPEN_PRESS.customId : '';

async function atTierLimit(commandLabel?: typeof RENAMED) {
  const h = harness();

  for (let i = 0; i < 3; i++) {
    await h.store.reserve({
      guildId: GUILD,
      typeId: TYPE.id,
      panelId: PANEL.id,
      openerId: MEMBER,
      priority: TYPE.defaultPriority,
    });
  }

  const outcome = await mayOpen({
    ctx: h.context(commandLabel ? { commandLabel } : {}),
    store: h.store,
    type: TYPE,
    openerId: MEMBER,
    now: h.now(),
    deps: h.deps,
  });

  if (outcome.ok) throw new Error('a member at the tier limit was let through');
  return outcome.humanReason;
}

describe('/ticket names its commands the way this server shows them', () => {
  test('an unknown ticket number points at the renamed list', async () => {
    const h = harness();

    await h.run(subcommand('close', [integerOption('number', 99)]), {
      ...MOD,
      channelId: PANEL_CHANNEL,
      commandLabel: RENAMED,
    });

    expect(h.lastTold()).toContain(
      'Couldn’t find ticket #99. `/support list` shows the open ones.',
    );
  });

  test('an unknown subcommand names the renamed command', async () => {
    const h = harness();

    await h.run(subcommand('dance'), { ...MOD, commandLabel: RENAMED });

    expect(h.lastTold()).toContain('I don’t recognise that `/support` subcommand.');
  });

  test('without a label source an unknown subcommand names /ticket as it always has', async () => {
    const h = harness();

    await h.run(subcommand('dance'), MOD);

    expect(h.lastTold()).toContain('I don’t recognise that `/ticket` subcommand.');
  });

  test('the tier refusal names the renamed close and list', async () => {
    const said = await atTierLimit(RENAMED);

    expect(said).toContain('Close one with `/support close` inside it.');
    expect(said).toContain(
      'Find its number with `/support list` and close it from anywhere with ' +
        '`/support close number:<number>`.',
    );
    expect(said).not.toContain('/ticket');
  });

  test('without a label source the tier refusal names /ticket as it always has', async () => {
    const said = await atTierLimit();

    expect(said).toEndWith(
      'Close one with `/ticket close` inside it. A ticket channel deleted without being closed ' +
        'may still count. Find its number with `/ticket list` and close it from anywhere with ' +
        '`/ticket close number:<number>`.',
    );
  });

  test('a ticket whose row was lost while opening names the renamed close', async () => {
    const h = harness();
    h.store.attach = async () => null;

    await h.press(pressEvent(OPEN), { commandLabel: RENAMED });

    expect(h.lastTold()).toContain(
      'so `/support close` won’t work there. Ask staff to delete the channel when you’re done.',
    );
  });

  test('without a label source a lost ticket names /ticket close as it always has', async () => {
    const h = harness();
    h.store.attach = async () => null;

    await h.press(pressEvent(OPEN));

    expect(h.lastTold()).toContain(
      'so `/ticket close` won’t work there. Ask staff to delete the channel when you’re done.',
    );
  });
});
