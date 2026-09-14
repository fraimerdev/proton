import { describe, expect, test } from 'bun:test';
import { type ActionRequest, Permissions, type RawOption } from '@proton/core';
import { xpCommand } from '../src/commands.ts';
import { XP_EVENT_MAX_PENDING, XP_EVENT_RETENTION_MS } from '../src/config.ts';
import type { LevelingDeps } from '../src/deps.ts';
import { xpEventId } from '../src/event-commands.ts';
import { APPLICATION, commandContext, FakeXpEventStore, GUILD, USER, xpEvent } from './fakes.ts';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function eventOptions(sub: string, options: RawOption[] = []): RawOption[] {
  return [{ name: 'event', type: 2, options: [{ name: sub, type: 1, options }] }];
}

function startOptions(multiplier: number, duration: string, startsIn?: string): RawOption[] {
  return eventOptions('start', [
    { name: 'multiplier', type: 10, value: multiplier },
    { name: 'duration', type: 3, value: duration },
    ...(startsIn === undefined ? [] : [{ name: 'starts_in', type: 3, value: startsIn }]),
  ]);
}

function depsWith(store: FakeXpEventStore, extra: LevelingDeps = {}): LevelingDeps {
  return { xpEvents: store, applicationId: APPLICATION, now: () => NOW, ...extra };
}

function answerOf(sent: ActionRequest[]): ActionRequest | undefined {
  return sent.findLast((request) => request.kind === 'interaction_followup');
}

function contentOf(sent: ActionRequest[]): string {
  const payload = answerOf(sent)?.payload as { content?: string } | undefined;
  return payload?.content ?? '';
}

describe('/xp event start', () => {
  test('defers ephemerally before touching the store, then answers without pinging anyone', async () => {
    const timeline: string[] = [];
    const store = new FakeXpEventStore(timeline);
    const { ctx, sent } = commandContext(startOptions(2, '2h'), {}, timeline);

    await xpCommand(depsWith(store)).handler(ctx);

    expect(timeline[0]).toBe('exec:interaction_reply');
    expect(timeline.indexOf('exec:interaction_reply')).toBeLessThan(
      timeline.indexOf('store:create'),
    );
    expect(sent[0]?.payload).toMatchObject({ callbackType: 5, ephemeral: true });

    const answer = answerOf(sent)?.payload;
    expect(answer).toMatchObject({ ephemeral: true, allowedMentions: { parse: [] } });
    expect(contentOf(sent)).toContain('XP event started');
    expect(contentOf(sent)).toContain('2×');
  });

  test('stores the event with an id taken from the interaction', async () => {
    const store = new FakeXpEventStore();
    const { ctx } = commandContext(startOptions(1.5, '2h'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(store.of(GUILD)).toEqual([
      {
        guildId: GUILD,
        id: xpEventId(ctx.interaction.id),
        multiplier: 1.5,
        startsAt: NOW,
        endsAt: NOW + 2 * HOUR,
        createdBy: USER,
        createdAt: NOW,
      },
    ]);
  });

  test('starts_in schedules it instead of starting it', async () => {
    const store = new FakeXpEventStore();
    const { ctx, sent } = commandContext(startOptions(3, '1d', '2d'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(store.of(GUILD)[0]).toMatchObject({ startsAt: NOW + 2 * DAY, endsAt: NOW + 3 * DAY });
    expect(contentOf(sent)).toContain('XP event scheduled');
    expect(contentOf(sent)).toContain(`<t:${Math.floor((NOW + 2 * DAY) / 1000)}:R>`);
  });

  test('a redelivered interaction creates one event, and the answer is the same request', async () => {
    const store = new FakeXpEventStore();
    const { ctx, sent } = commandContext(startOptions(2, '2h'));
    const command = xpCommand(depsWith(store));

    await command.handler(ctx);
    await command.handler(ctx);

    expect(store.of(GUILD)).toHaveLength(1);

    const answers = sent.filter((request) => request.kind === 'interaction_followup');
    expect(answers).toHaveLength(2);
    expect(answers[0]?.idempotencyKey).toBe(answers[1]?.idempotencyKey ?? 'different');
  });

  test('clears out events that ended more than a week ago once one is created', async () => {
    const store = new FakeXpEventStore().seed(
      xpEvent({ id: 'old', startsAt: NOW - 9 * DAY, endsAt: NOW - 8 * DAY }),
      xpEvent({ id: 'recent', startsAt: NOW - 2 * DAY, endsAt: NOW - DAY }),
    );
    const { ctx } = commandContext(startOptions(2, '2h'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(store.purges).toEqual([{ guildId: GUILD, before: NOW - XP_EVENT_RETENTION_MS }]);
    expect(store.of(GUILD).map((event) => event.id)).toEqual([
      'recent',
      xpEventId(ctx.interaction.id),
    ]);
  });

  test(`refuses a sixth event while ${XP_EVENT_MAX_PENDING} are active or scheduled`, async () => {
    const store = new FakeXpEventStore().seed(
      ...Array.from({ length: XP_EVENT_MAX_PENDING }, (_, index) =>
        xpEvent({ id: `pending-${index}`, startsAt: NOW + index * HOUR, endsAt: NOW + DAY }),
      ),
    );
    const { ctx, sent } = commandContext(startOptions(2, '2h'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(store.of(GUILD)).toHaveLength(XP_EVENT_MAX_PENDING);
    expect(contentOf(sent)).toContain(`${XP_EVENT_MAX_PENDING} is the most it can have`);
    expect(contentOf(sent)).toContain('Nothing was started');
  });

  test('out-of-range input is refused and nothing is created', async () => {
    const cases: RawOption[][] = [
      startOptions(0.15, '2h'),
      startOptions(6, '2h'),
      startOptions(2, '5m'),
      startOptions(2, '15d'),
      startOptions(2, 'soon'),
      startOptions(2, '2h', '31d'),
    ];

    for (const options of cases) {
      const store = new FakeXpEventStore();
      const { ctx, sent } = commandContext(options);

      await xpCommand(depsWith(store)).handler(ctx);

      expect(store.calls).not.toContain('create');
      expect(contentOf(sent)).toContain('Nothing was started');
    }
  });
});

describe('/xp event end', () => {
  test('ends every active event now, says how many, and leaves scheduled ones alone', async () => {
    const store = new FakeXpEventStore().seed(
      xpEvent({ id: 'a', startsAt: NOW - HOUR, endsAt: NOW + HOUR }),
      xpEvent({ id: 'b', startsAt: NOW - MINUTE, endsAt: NOW + DAY }),
      xpEvent({ id: 'later', startsAt: NOW + DAY, endsAt: NOW + 2 * DAY }),
    );
    const { ctx, sent } = commandContext(eventOptions('end'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(contentOf(sent)).toContain('Ended 2 XP events.');
    expect(contentOf(sent)).toContain('1 scheduled XP event is untouched');
    expect(store.of(GUILD).map((event) => [event.id, event.endsAt])).toEqual([
      ['a', NOW],
      ['b', NOW],
      ['later', NOW + 2 * DAY],
    ]);
  });

  test('with nothing running it says there was nothing to end', async () => {
    const store = new FakeXpEventStore();
    const { ctx, sent } = commandContext(eventOptions('end'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(contentOf(sent)).toContain('nothing to end');
  });
});

describe('/xp event list', () => {
  test('lists active and scheduled events with relative times', async () => {
    const store = new FakeXpEventStore().seed(
      xpEvent({ id: 'now', multiplier: 2, startsAt: NOW - HOUR, endsAt: NOW + HOUR }),
      xpEvent({ id: 'next', multiplier: 1.5, startsAt: NOW + DAY, endsAt: NOW + 2 * DAY }),
      xpEvent({ id: 'gone', startsAt: NOW - 2 * DAY, endsAt: NOW - DAY }),
    );
    const { ctx, sent } = commandContext(eventOptions('list'));

    await xpCommand(depsWith(store)).handler(ctx);

    const content = contentOf(sent);
    expect(content).toContain(`(2 of ${XP_EVENT_MAX_PENDING})`);
    expect(content).toContain(`**Active** · 2× XP, ends <t:${Math.floor((NOW + HOUR) / 1000)}:R>`);
    expect(content).toContain(
      `**Scheduled** · 1.5× XP, starts <t:${Math.floor((NOW + DAY) / 1000)}:R>`,
    );
    expect(content).not.toContain(`${Math.floor((NOW - DAY) / 1000)}`);
    expect(answerOf(sent)?.payload).toMatchObject({ allowedMentions: { parse: [] } });
  });

  test('says so when there are none', async () => {
    const { ctx, sent } = commandContext(eventOptions('list'));

    await xpCommand(depsWith(new FakeXpEventStore())).handler(ctx);

    expect(contentOf(sent)).toContain('no active or scheduled XP events');
  });
});

describe('/xp event gating', () => {
  test('lives inside /xp, so it carries the same Manage Server default permission', () => {
    const data = xpCommand({}).data;

    expect(data.default_member_permissions).toBe(Permissions.ManageGuild.toString());

    const group = data.options?.find((option) => option.name === 'event') as
      | { type: number; options?: { name: string }[] }
      | undefined;
    expect(group?.type).toBe(2);
    expect(group?.options?.map((option) => option.name)).toEqual(['start', 'end', 'list']);
  });

  test('a server with Leveling switched off is refused before anything is stored', async () => {
    const store = new FakeXpEventStore();
    const { ctx, sent } = commandContext(startOptions(2, '2h'), { enabled: false });

    await xpCommand(depsWith(store)).handler(ctx);

    expect(store.calls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ ephemeral: true });
    expect((sent[0]?.payload as { content?: string } | undefined)?.content).toContain(
      'switched off',
    );
  });

  test('a process built without the event store refuses and names the missing port', async () => {
    const { ctx, sent, logs } = commandContext(startOptions(2, '2h'));

    await xpCommand({ applicationId: APPLICATION, now: () => NOW }).handler(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ ephemeral: true, allowedMentions: { parse: [] } });
    expect(logs.some((line) => line.startsWith('error:') && line.includes('xpEvents'))).toBe(true);
  });

  test('a store that fails mid-command still gets the invoker an answer', async () => {
    const store = new FakeXpEventStore();
    store.pending = async () => {
      throw new Error('postgres is down');
    };
    const { ctx, sent, logs } = commandContext(eventOptions('list'));

    await xpCommand(depsWith(store)).handler(ctx);

    expect(contentOf(sent)).toContain('/xp event list');
    expect(logs.some((line) => line.includes('postgres is down'))).toBe(true);
  });
});
