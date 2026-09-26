import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type CommandLabeler,
  formatCommandLabel,
  type RawOption,
  STATUS_ERROR_EMOJI,
} from '@proton/core';
import { xpCommand } from '../src/commands.ts';
import { APPLICATION, commandContext, FakeXpEventStore, FakeXpStore } from './fakes.ts';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');

const renamed: CommandLabeler = (key, path) =>
  formatCommandLabel(key, path, key === 'xp' ? 'points' : undefined);

function event(sub: string, options: RawOption[] = []): RawOption[] {
  return [{ name: 'event', type: 2, options: [{ name: sub, type: 1, options }] }];
}

function textOf(sent: ActionRequest[]): string {
  const payload = sent.findLast(
    (request) => request.kind === 'interaction_reply' || request.kind === 'interaction_followup',
  )?.payload as { content?: string; embeds?: { description?: string }[] } | undefined;

  return payload?.content || payload?.embeds?.[0]?.description || '';
}

async function run(options: RawOption[], commandLabel?: CommandLabeler): Promise<string> {
  const { ctx, sent } = commandContext(options);
  if (commandLabel) ctx.commandLabel = commandLabel;

  await xpCommand({
    xp: new FakeXpStore(),
    xpEvents: new FakeXpEventStore(),
    applicationId: APPLICATION,
    now: () => NOW,
  }).handler(ctx);

  return textOf(sent);
}

describe('leveling names /xp as this server shows it', () => {
  test('an unknown adjustment points at the renamed subcommands', async () => {
    expect(await run([], renamed)).toBe(
      `${STATUS_ERROR_EMOJI} Use /points give, /points take or /points set.`,
    );
  });

  test('an unknown adjustment keeps the code names when nothing is renamed', async () => {
    expect(await run([])).toBe(`${STATUS_ERROR_EMOJI} Use /xp give, /xp take or /xp set.`);
  });

  test('an empty event list says how to start one under the renamed command', async () => {
    expect(await run(event('list'), renamed)).toBe(
      'No XP events are running or scheduled. Start one with /points event start.',
    );
    expect(await run(event('list'))).toBe(
      'No XP events are running or scheduled. Start one with /xp event start.',
    );
  });

  test('a start without a duration shows the example under the renamed command', async () => {
    const options = event('start', [{ name: 'multiplier', type: 10, value: 2 }]);

    expect(await run(options, renamed)).toContain('`/points event start multiplier:2 duration:2h`');
    expect(await run(options)).toContain('`/xp event start multiplier:2 duration:2h`');
  });
});
