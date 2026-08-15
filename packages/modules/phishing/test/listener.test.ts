import { describe, expect, test } from 'bun:test';
import type { EventListener } from '@proton/core';
import type { PhishingConfig } from '../src/config.ts';
import { createPhishingListener, PHISHING_EVENT_TYPES } from '../src/listener.ts';
import {
  ALERT_CHANNEL,
  AUTHOR,
  BAD_DOMAIN,
  BOT,
  context,
  type Harness,
  LOOKALIKE_DOMAIN,
  MemoryBlocklistStore,
  messageEvent,
  payloadOf,
} from './harness.ts';

function listener(store: MemoryBlocklistStore): EventListener<PhishingConfig> {
  return createPhishingListener({ blocklist: store, botUserId: BOT });
}

function loaded(): MemoryBlocklistStore {
  return new MemoryBlocklistStore([BAD_DOMAIN, 'discord-nitro.gift']);
}

async function handle(
  store: MemoryBlocklistStore,
  content: string,
  config: Partial<PhishingConfig> = {},
  overrides: Parameters<typeof messageEvent>[0] = {},
): Promise<Harness> {
  const harness = context(config);
  await listener(store).handler(messageEvent({ content, ...overrides }), harness.ctx);
  return harness;
}

describe('phishing listener', () => {
  test('watches creates and edits — editing a link in must not beat the filter', () => {
    expect(PHISHING_EVENT_TYPES).toEqual(['message.created', 'message.updated']);
  });

  test('a known-bad domain times the author out and names the domain in the reason', async () => {
    const { executor } = await handle(loaded(), `free skins at https://${BAD_DOMAIN}/gift`);

    const request = executor.of('timeout');
    expect(request).toBeDefined();
    expect(request?.targetId).toBe(AUTHOR);
    expect(request?.moduleId).toBe('phishing');
    expect(request?.reason).toContain(BAD_DOMAIN);
    // Discord lifts a timeout itself, so nothing schedules a reversal.
    expect(request?.expiresAt).toBeUndefined();
  });

  test('a subdomain of a listed domain still matches', async () => {
    const { executor } = await handle(loaded(), `https://login.trade.${BAD_DOMAIN}/x`);
    expect(executor.of('timeout')).toBeDefined();
  });

  test('a matching bare domain with no scheme still matches', async () => {
    const { executor } = await handle(loaded(), `go to ${BAD_DOMAIN} quick`);
    expect(executor.of('timeout')).toBeDefined();
  });

  /** The false-positive path — the real site the listed one impersonates. */
  test('a lookalike of a listed domain is not acted on', async () => {
    const { executor, logs } = await handle(
      loaded(),
      `the real one is https://${LOOKALIKE_DOMAIN}/market`,
    );

    expect(executor.requests).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('a host that merely contains a listed domain is not acted on', async () => {
    const store = loaded();
    for (const content of [
      `not${BAD_DOMAIN}`,
      `${BAD_DOMAIN}.example.org`,
      'https://steamcommunity-gift.com/gift',
    ]) {
      const { executor } = await handle(store, content);
      expect(executor.requests).toEqual([]);
    }
  });

  test('an ordinary message costs no blocklist lookup at all', async () => {
    const store = loaded();
    let lookups = 0;
    const original = store.lookup.bind(store);
    store.lookup = async (candidates) => {
      lookups++;
      return original(candidates);
    };

    await handle(store, 'good morning everyone');
    expect(lookups).toBe(0);
  });

  test("the server's allowlist wins over the community list", async () => {
    const { executor } = await handle(loaded(), `https://${BAD_DOMAIN}/gift`, {
      allowDomains: [BAD_DOMAIN],
    });

    expect(executor.requests).toEqual([]);
  });

  test('an allowed link in the same message does not immunise a blocked one', async () => {
    const { executor } = await handle(
      loaded(),
      `see https://${LOOKALIKE_DOMAIN}/ and https://${BAD_DOMAIN}/gift`,
      { allowDomains: [LOOKALIKE_DOMAIN] },
    );

    expect(executor.of('timeout')).toBeDefined();
  });

  test("the server's own blocklist matches without touching the cache", async () => {
    const store = new MemoryBlocklistStore();
    store.failLookupWith = new Error('the cache must not be consulted');

    const { executor } = await handle(store, 'https://our-scammer.example/x', {
      blockDomains: ['our-scammer.example'],
    });

    expect(executor.of('timeout')).toBeDefined();
  });

  test('action "none" alerts without acting, for an observe-only rollout', async () => {
    const { executor } = await handle(loaded(), `https://${BAD_DOMAIN}/gift`, {
      action: 'none',
      alertChannel: ALERT_CHANNEL,
    });

    expect(executor.of('timeout')).toBeUndefined();
    const alert = payloadOf(executor.of('send'));
    expect(alert).toMatchObject({ channelId: ALERT_CHANNEL });
    expect(String(alert.content)).toContain('No action was taken');
  });

  test('the alert names the host, the listed domain and admits the message is still up', async () => {
    const { executor } = await handle(loaded(), `https://login.${BAD_DOMAIN}/gift`, {
      alertChannel: ALERT_CHANNEL,
    });

    const content = String(payloadOf(executor.of('send')).content);
    expect(content).toContain(`login.${BAD_DOMAIN}`);
    expect(content).toContain(BAD_DOMAIN);
    // Proton cannot delete a single message, so the alert must never imply it did.
    expect(content).not.toContain('removed');
    expect(content).toContain('still up');
  });

  test('no alert channel means no send, and the action still happens', async () => {
    const { executor } = await handle(loaded(), `https://${BAD_DOMAIN}/gift`);

    expect(executor.of('send')).toBeUndefined();
    expect(executor.of('timeout')).toBeDefined();
  });

  /**
   * The double-action case, and the reason keys are rooted on the message
   * rather than on the event.
   *
   * This module watches both `message.created` and `message.updated`, and the
   * normaliser gives them different ids by design — it has to, or an edit would
   * dedupe against the post it edits and never be scanned. But Discord raises
   * MESSAGE_UPDATE for its own embed resolution, carrying (per the gateway
   * reference) the full message object with the original content. A message with
   * a link is by definition one Discord unfurls, so an event-rooted key means
   * one scam link times the author out twice.
   */
  test('the create and the embed-resolution update act once between them', async () => {
    const created = await handle(loaded(), `https://${BAD_DOMAIN}/gift`, {
      alertChannel: ALERT_CHANNEL,
    });

    const harness = context({ alertChannel: ALERT_CHANNEL });
    await listener(loaded()).handler(
      // Same message id, different event id — exactly what Discord sends when it
      // resolves the preview on the link that was just posted.
      messageEvent({ type: 'message.updated', content: `https://${BAD_DOMAIN}/gift` }),
      harness.ctx,
    );

    expect(harness.executor.of('timeout')?.idempotencyKey).toBe(
      created.executor.of('timeout')?.idempotencyKey ?? '',
    );
    expect(harness.executor.of('send')?.idempotencyKey).toBe(
      created.executor.of('send')?.idempotencyKey ?? '',
    );
  });

  test('a different message is a different key, so a second scam is still caught', async () => {
    const first = await handle(loaded(), `https://${BAD_DOMAIN}/gift`);

    const harness = context();
    await listener(loaded()).handler(
      messageEvent({ id: '1400000000000009999', content: `https://${BAD_DOMAIN}/gift` }),
      harness.ctx,
    );

    expect(harness.executor.of('timeout')?.idempotencyKey).not.toBe(
      first.executor.of('timeout')?.idempotencyKey ?? '',
    );
  });

  test('idempotency keys survive a redelivery, so it acts once', async () => {
    const first = await handle(loaded(), `https://${BAD_DOMAIN}/gift`, {
      alertChannel: ALERT_CHANNEL,
    });
    const second = await handle(loaded(), `https://${BAD_DOMAIN}/gift`, {
      alertChannel: ALERT_CHANNEL,
    });

    expect(first.executor.of('timeout')?.idempotencyKey).toBe(
      second.executor.of('timeout')?.idempotencyKey ?? '',
    );
    // Distinct from the alert's, or one would dedupe against the other.
    expect(first.executor.of('timeout')?.idempotencyKey).not.toBe(
      first.executor.of('send')?.idempotencyKey ?? '',
    );
  });

  test('the module never scans its own alerts, which would loop forever', async () => {
    const { executor } = await handle(
      loaded(),
      `Phishing link detected. Link host: \`${BAD_DOMAIN}\``,
      { alertChannel: ALERT_CHANNEL },
      { authorId: BOT },
    );

    expect(executor.requests).toEqual([]);
  });

  test('a disabled module reads nothing', async () => {
    const store = loaded();
    store.failLookupWith = new Error('a disabled module must not touch the cache');

    const { executor } = await handle(store, `https://${BAD_DOMAIN}/gift`, { enabled: false });
    expect(executor.requests).toEqual([]);
  });

  test('a DM is ignored — no guild, no config, no moderators', async () => {
    const harness = context();
    await listener(loaded()).handler(
      messageEvent({ content: `https://${BAD_DOMAIN}/gift`, guildId: null }),
      harness.ctx,
    );

    expect(harness.executor.requests).toEqual([]);
  });

  test('a partial MESSAGE_UPDATE with no content is ignored rather than throwing', async () => {
    const harness = context();
    const event = messageEvent({ type: 'message.updated' });
    (event.payload as Record<string, unknown>).content = undefined;

    await expect(listener(loaded()).handler(event, harness.ctx)).resolves.toBeUndefined();
    expect(harness.executor.requests).toEqual([]);
  });
});

/** The degraded paths. Every one of them has to keep message handling alive. */
describe('phishing degradation', () => {
  test('an empty blocklist acts on nothing and does not throw', async () => {
    const { executor, logs } = await handle(new MemoryBlocklistStore(), `https://${BAD_DOMAIN}/x`);

    expect(executor.requests).toEqual([]);
    expect(logs).toEqual([]);
  });

  test('an unreachable cache is logged and the message is let through, not retried', async () => {
    const store = new MemoryBlocklistStore([BAD_DOMAIN]);
    store.failLookupWith = new Error('Connection is closed.');

    const { executor, logs } = await handle(store, `https://${BAD_DOMAIN}/x`);

    // Never a throw: the bus would leave the event unacknowledged and redeliver
    // it forever, turning a cache problem into a message-processing outage.
    expect(executor.requests).toEqual([]);
    const errored = logs.find((entry) => entry.level === 'error');
    expect(errored?.message).toContain('not checked');
    expect(errored?.message).toContain('Connection is closed.');
  });

  test('an unbound module names the port and the constructor, but only once there is a link', async () => {
    const unbound = createPhishingListener({});

    const quiet = context();
    await unbound.handler(messageEvent({ content: 'good morning' }), quiet.ctx);
    expect(quiet.logs).toEqual([]);

    const loud = context();
    await unbound.handler(messageEvent({ content: `https://${BAD_DOMAIN}/x` }), loud.ctx);
    expect(loud.logs[0]?.level).toBe('error');
    expect(loud.logs[0]?.message).toContain('RedisBlocklistStore');
    expect(loud.logs[0]?.message).toContain('createPhishingModule');
  });
});

/** The permission-failure path every module owes an integration test (§12). */
describe('phishing permission failures', () => {
  test('a refused timeout repeats the executor’s reason verbatim, naming the permission', async () => {
    const harness = context();
    harness.executor.results.timeout = {
      status: 'failed_precheck',
      failure: {
        code: 'missing_permission',
        humanReason:
          'Proton needs the ModerateMembers permission in this server, and does not have it.',
      },
    };

    await listener(loaded()).handler(
      messageEvent({ content: `https://${BAD_DOMAIN}/gift` }),
      harness.ctx,
    );

    const errored = harness.logs.find(
      (entry) => entry.level === 'error' && entry.message.includes('could not timeout'),
    );
    expect(errored?.message).toContain('ModerateMembers');
    expect(errored?.message).toContain(BAD_DOMAIN);
  });

  test('a refused alert is reported and does not mask the action that did happen', async () => {
    const harness = context({ alertChannel: ALERT_CHANNEL });
    harness.executor.results.send = {
      status: 'failed_precheck',
      failure: {
        code: 'missing_permission',
        humanReason: `Proton cannot send messages in <#${ALERT_CHANNEL}>.`,
      },
    };

    await listener(loaded()).handler(
      messageEvent({ content: `https://${BAD_DOMAIN}/gift` }),
      harness.ctx,
    );

    expect(harness.executor.of('timeout')).toBeDefined();
    const errored = harness.logs.find((entry) =>
      entry.message.includes('could not post its alert'),
    );
    expect(errored?.message).toContain('cannot send messages');
  });
});
