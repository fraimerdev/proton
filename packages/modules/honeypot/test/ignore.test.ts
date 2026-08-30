import { describe, expect, test } from 'bun:test';
import {
  armed,
  BOOST_MESSAGE_TYPE,
  BOT,
  GUILD,
  type Harness,
  harness,
  JOIN_MESSAGE_TYPE,
  LOUNGE,
  MESSAGE,
  TRAP,
  trap,
} from './harness.ts';

function quiet(h: Harness): { calls: string[]; claims: number; published: number } {
  return { calls: h.calls(), claims: h.lock.attempts.length, published: h.published.length };
}

const NOTHING = { calls: [], claims: 0, published: 0 };

describe('a message the honeypot must not act on', () => {
  test('the module is switched off in this server', async () => {
    const h = harness();

    const outcome = await h.trip({ config: { channels: [trap()] } });

    expect(outcome).toEqual({ action: 'ignored', reason: 'honeypot is off in this server' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('the module is on but no channel is a honeypot yet', async () => {
    const h = harness();

    const outcome = await h.trip({ config: { enabled: true } });

    expect(outcome).toEqual({
      action: 'ignored',
      reason: 'no honeypot channels are configured',
    });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('the channel it was posted in is not a honeypot', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), channelId: LOUNGE });

    expect(outcome).toEqual({ action: 'ignored', reason: 'not a honeypot channel' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('the honeypot row is switched off', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: { enabled: true, channels: [trap({ enabled: false })] },
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'not a honeypot channel' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('Proton posted it', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), authorId: BOT });

    expect(outcome).toEqual({ action: 'ignored', reason: 'self' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('another bot posted it', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), bot: true });

    expect(outcome).toEqual({ action: 'ignored', reason: 'bot' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('a webhook posted it', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), webhookId: '810000000000000001' });

    expect(outcome).toEqual({ action: 'ignored', reason: 'webhook' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('it is a join announcement, not something the member wrote', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), type: JOIN_MESSAGE_TYPE });

    expect(outcome).toEqual({ action: 'ignored', reason: 'system_message' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('it is a boost notice, not something the member wrote', async () => {
    const h = harness();

    const outcome = await h.trip({ config: armed(), type: BOOST_MESSAGE_TYPE });

    expect(outcome).toEqual({ action: 'ignored', reason: 'system_message' });
    expect(quiet(h)).toEqual(NOTHING);
  });

  test('the payload carries no author to act on', async () => {
    const h = harness();

    const outcome = await h.trip({
      config: armed(),
      payload: { id: MESSAGE, channel_id: TRAP, guild_id: GUILD },
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'unreadable message payload' });
    expect(quiet(h)).toEqual(NOTHING);
  });
});
