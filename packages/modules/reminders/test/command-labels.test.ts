import { describe, expect, test } from 'bun:test';
import { type CommandLabeler, formatCommandLabel, limitFor, newId } from '@proton/core';
import { renderPending } from '../src/render.ts';
import {
  CHANNEL,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  OTHER,
  stringOption,
  subcommand,
} from './harness.ts';

const NAMES: Record<string, string> = { remind: 'nudge', reminders: 'nudges' };

const renamed: CommandLabeler = (key, path) => formatCommandLabel(key, path, NAMES[key]);

async function fill(h: Harness): Promise<void> {
  for (let index = 0; index < limitFor('free', 'remindersPerUser'); index++) {
    await h.reminders.create({
      id: newId(),
      guildId: GUILD,
      userId: MEMBER,
      channelId: CHANNEL,
      content: `reminder ${index}`,
      remindAt: new Date(Date.now() + 60_000 * (index + 1)),
    });
  }
}

async function setOne(h: Harness): Promise<string> {
  await h.run('remind', [stringOption('duration', '2h'), stringOption('text', 'the bread')]);

  const reminder = [...h.reminders.rows.values()].at(-1);
  if (!reminder) throw new Error('the reminder was not stored');
  return reminder.id;
}

describe('reminders name commands as the server shows them', () => {
  test('the limit refusal names the renamed list and cancel commands', async () => {
    const h = harness();
    await fill(h);

    await h.run('remind', [stringOption('duration', '2h'), stringOption('text', 'one more')], {
      commandLabel: renamed,
    });

    const reply = h.replyContent() ?? '';
    expect(reply).toContain(
      '`/nudges list` shows the ones you already have, and `/nudges cancel` clears one.',
    );
    expect(reply).not.toContain('/reminders');
  });

  test('without a label source the limit refusal keeps the built-in names', async () => {
    const h = harness();
    await fill(h);

    await h.run('remind', [stringOption('duration', '2h'), stringOption('text', 'one more')]);

    expect(h.replyContent()).toContain(
      '`/reminders list` shows the ones you already have, and `/reminders cancel` clears one.',
    );
  });

  test('an empty list shows how to set one with the renamed command', async () => {
    const h = harness();

    await h.run('reminders', subcommand('list', []), { commandLabel: renamed });

    expect(h.replyContent()).toContain('Set one with `/nudge`');
  });

  test('a reminder that is gone points at the renamed list', async () => {
    const h = harness();

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', 'nothing-like-it')]), {
      commandLabel: renamed,
    });

    expect(h.replyContent()).toContain('`/nudges list` shows what you have waiting.');
  });

  test('somebody else’s reminder points at the renamed list', async () => {
    const h = harness();
    const id = await setOne(h);

    await h.run('reminders', subcommand('cancel', [stringOption('reminder', id)]), {
      userId: OTHER,
      commandLabel: renamed,
    });

    expect(h.replyEmbed()?.description).toContain('`/nudges list` shows yours.');
  });

  test('renderPending names the renamed command and falls back to the built-in one', () => {
    expect(renderPending([], 0, { commandLabel: renamed })).toContain('Set one with `/nudge`');
    expect(renderPending([], 0)).toContain('Set one with `/remind`');
  });
});
