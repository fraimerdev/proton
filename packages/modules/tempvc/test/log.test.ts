import { describe, expect, test } from 'bun:test';
import { renderLogLine, TEMP_VOICE_EVENTS } from '../src/log.ts';
import { ADA, BEN, CREATED, callsOf, harness, member } from './harness.ts';

const LOG_CHANNEL = '600000000000000009';

function logging(extra: Record<string, unknown> = {}) {
  return harness({ config: { loggingEnabled: true, logChannelId: LOG_CHANNEL }, ...extra });
}

const posted = (fake: ReturnType<typeof harness>) =>
  callsOf(fake, 'send').filter((call) => call.payload.channelId === LOG_CHANNEL);

describe('rendering', () => {
  test('every event has a heading, so none of them logs as undefined', () => {
    for (const event of TEMP_VOICE_EVENTS) {
      expect(`${event}: ${renderLogLine(event, {}).includes('undefined')}`).toBe(`${event}: false`);
    }
  });

  test('a line names the channel, the actor and the target when it has them', () => {
    const line = renderLogLine('blocked', { channelId: CREATED, actorId: ADA, targetId: BEN });

    expect(line).toContain(`<#${CREATED}>`);
    expect(line).toContain(`<@${ADA}>`);
    expect(line).toContain(`<@${BEN}>`);
  });

  test('it stays inside what Discord accepts', () => {
    expect(renderLogLine('error', { detail: 'x'.repeat(4000) }).length).toBeLessThanOrEqual(2000);
  });
});

describe('the logging settings actually do something', () => {
  test('nothing is posted while logging is off', async () => {
    const fake = harness();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(posted(fake)).toHaveLength(0);
  });

  test('nothing is posted when logging is on but no channel is chosen', async () => {
    const fake = harness({ config: { loggingEnabled: true } });
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(posted(fake)).toHaveLength(0);
  });

  test('a creation is logged', async () => {
    const fake = logging();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(posted(fake)[0]?.payload.content).toContain('Channel created');
  });

  test('a deletion is logged', async () => {
    const fake = logging();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.destroy(fake.ctx, fake.row(outcome.created.id), 'empty');

    expect(posted(fake)[0]?.payload.content).toContain('Channel deleted');
  });

  test('a block names who was blocked', async () => {
    const fake = logging();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.setAccess(fake.ctx, outcome.created, BEN, 'block', 'public');

    const line = posted(fake)
      .map((call) => call.payload.content)
      .join('\n');
    expect(line).toContain('Member blocked');
    expect(line).toContain(`<@${BEN}>`);
  });

  test('a privacy change is its own event, not an access change', async () => {
    const fake = logging();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.setPrivacy(fake.ctx, outcome.created, 'locked');

    expect(posted(fake)[0]?.payload.content).toContain('Privacy changed');
    expect(posted(fake)[0]?.payload.content).toContain('locked');
  });

  test('a transfer names both sides', async () => {
    const fake = logging();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.transfer(fake.ctx, outcome.created, BEN, 'public');

    const line = posted(fake)
      .map((call) => call.payload.content)
      .join('\n');
    expect(line).toContain('Ownership transferred');
    expect(line).toContain(`<@${BEN}>`);
  });

  test('a rename says what it became', async () => {
    const fake = logging();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.calls.length = 0;
    await fake.service.rename(fake.ctx, outcome.created, 'Study room');

    expect(posted(fake)[0]?.payload.content).toContain('Study room');
  });

  /** A log line must never ping the people it names. */
  test('a log line suppresses mentions', async () => {
    const fake = logging();
    await fake.service.create(fake.ctx, fake.hub, member());

    expect(posted(fake)[0]?.payload.allowedMentions).toEqual({ parse: [] });
  });

  /** The channel is being removed; failing the deletion because the log bounced would be worse. */
  test('a log that cannot be posted does not fail the action it reports', async () => {
    const fake = logging();
    const outcome = await fake.service.create(fake.ctx, fake.hub, member());
    if (!('created' in outcome)) throw new Error('expected a channel');

    fake.refuse('send', 'missing_permission', 'I am missing Send Messages there.');

    expect(await fake.service.destroy(fake.ctx, fake.row(outcome.created.id), 'empty')).toBe(true);
    expect(fake.repository.rows.size).toBe(0);
  });
});
