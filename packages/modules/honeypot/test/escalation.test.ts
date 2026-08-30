import { describe, expect, test } from 'bun:test';
import { QUOTE_MAX } from '../src/embed.ts';
import { armed, GUILD, harness, LOG, LOW_ROLE, MEMBER, MESSAGE, TRAP } from './harness.ts';

const LOGGED = { ...armed(), logChannelId: LOG };

function fields(embed: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(embed?.fields) ? (embed.fields as Array<Record<string, unknown>>) : [];
}

function fieldNamed(embed: Record<string, unknown> | null, name: string): string | undefined {
  const found = fields(embed).find((field) => field.name === name);

  return found === undefined ? undefined : String(found.value);
}

describe('quoting the message', () => {
  test('is off by default, and the log carries no quote', async () => {
    const h = harness();

    await h.trip({ config: LOGGED, roleIds: [LOW_ROLE] });

    expect(fieldNamed(h.embedIn(LOG), 'What they posted')).toBeUndefined();
  });

  test('puts what they posted in the incident log when it is on', async () => {
    const h = harness();

    await h.trip({
      config: { ...LOGGED, quoteMessage: true },
      roleIds: [LOW_ROLE],
      payloadContent: 'free nitro at example.com',
    });

    expect(fieldNamed(h.embedIn(LOG), 'What they posted')).toContain('free nitro at example.com');
  });

  // A message ending in a backtick would otherwise close the fence and turn the rest of the embed
  // into whatever markdown it wanted.
  test('cannot break out of its own code fence', async () => {
    const h = harness();

    await h.trip({
      config: { ...LOGGED, quoteMessage: true },
      roleIds: [LOW_ROLE],
      payloadContent: '``` **not a heading**',
    });

    const quote = fieldNamed(h.embedIn(LOG), 'What they posted') ?? '';

    expect(quote.startsWith('```')).toBe(true);
    expect(quote.endsWith('```')).toBe(true);
    expect(quote.slice(3, -3)).not.toContain('`');
  });

  test('is cut rather than truncating the embed Discord would refuse', async () => {
    const h = harness();

    await h.trip({
      config: { ...LOGGED, quoteMessage: true },
      roleIds: [LOW_ROLE],
      payloadContent: 'x'.repeat(4000),
    });

    const quote = fieldNamed(h.embedIn(LOG), 'What they posted') ?? '';

    expect(quote.length).toBeLessThanOrEqual(1024);
    expect(quote).toContain('…');
  });

  test('an empty message adds no field at all', async () => {
    const h = harness();

    await h.trip({
      config: { ...LOGGED, quoteMessage: true },
      roleIds: [LOW_ROLE],
      payloadContent: '   ',
    });

    expect(fieldNamed(h.embedIn(LOG), 'What they posted')).toBeUndefined();
    expect(QUOTE_MAX).toBeGreaterThan(0);
  });
});

describe('adding them to the blacklist', () => {
  test('is off by default, and writes nothing', async () => {
    const h = harness();

    await h.trip({ config: armed(), roleIds: [LOW_ROLE] });

    expect(h.blocked.blocks).toEqual([]);
  });

  test('records the member, the reason, and what they posted it for', async () => {
    const h = harness();

    await h.trip({ config: armed({ addToBlacklist: true }), roleIds: [LOW_ROLE] });

    expect(h.blocked.blocks).toHaveLength(1);
    expect(h.blocked.blocks[0]).toMatchObject({
      guildId: GUILD,
      userId: MEMBER,
      moduleId: 'honeypot',
      evidence: { channelId: TRAP, messageId: MESSAGE },
    });
  });

  test('a redelivered message does not block them twice', async () => {
    const h = harness();

    await h.trip({ config: armed({ addToBlacklist: true }), roleIds: [LOW_ROLE] });
    await h.trip({ config: armed({ addToBlacklist: true }), roleIds: [LOW_ROLE] });

    expect(h.blocked.blocks).toHaveLength(1);
  });

  test('an exempt catch is never blocked — nothing was done to them', async () => {
    const h = harness();

    await h.trip({
      config: armed({ addToBlacklist: true, exemptRoleIds: [LOW_ROLE] }),
      roleIds: [LOW_ROLE],
    });

    expect(h.blocked.blocks).toEqual([]);
  });

  test('a refused punishment blocks nobody either', async () => {
    const h = harness({ botPermissions: 0n });

    await h.trip({ config: armed({ addToBlacklist: true }), roleIds: [LOW_ROLE] });

    expect(h.blocked.blocks).toEqual([]);
  });

  test('says so loudly when the port was never wired up', async () => {
    const h = harness({ blocked: false });

    await h.trip({ config: armed({ addToBlacklist: true }), roleIds: [LOW_ROLE] });

    expect(h.said('error').join(' ')).toContain('NOT added to the blocked list');
  });
});
