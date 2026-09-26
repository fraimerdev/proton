import { describe, expect, test } from 'bun:test';
import type { EventListener } from '@proton/core';
import type { PhishingConfig } from '../src/config.ts';
import { createPhishingListener, PHISHING_EVENT_TYPES } from '../src/listener.ts';
import {
  ALERT_CHANNEL,
  AUTHOR,
  BAD_DOMAIN,
  BOT,
  type CapturedLog,
  context,
  type Harness,
  LOOKALIKE_DOMAIN,
  liveContext,
  MemoryBlocklistStore,
  messageEvent,
  payloadOf,
  type RecordingExecutor,
  recentMessageId,
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

    expect(content).not.toContain('removed');
    expect(content).toContain('still up');
  });

  test('no alert channel means no send, and the action still happens', async () => {
    const { executor } = await handle(loaded(), `https://${BAD_DOMAIN}/gift`);

    expect(executor.of('send')).toBeUndefined();
    expect(executor.of('timeout')).toBeDefined();
  });

  test('the create and the embed-resolution update act once between them', async () => {
    const created = await handle(loaded(), `https://${BAD_DOMAIN}/gift`, {
      alertChannel: ALERT_CHANNEL,
    });

    const harness = context({ alertChannel: ALERT_CHANNEL });
    await listener(loaded()).handler(
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

describe('phishing permission failures', () => {
  test('a refused timeout repeats the executor’s reason verbatim, naming the permission', async () => {
    const harness = context();
    harness.executor.results.timeout = {
      status: 'failed_precheck',
      failure: {
        code: 'missing_permission',
        humanReason:
          'Proton needs the Timeout Members permission in this server, and does not have it.',
      },
    };

    await listener(loaded()).handler(
      messageEvent({ content: `https://${BAD_DOMAIN}/gift` }),
      harness.ctx,
    );

    const errored = harness.logs.find(
      (entry) => entry.level === 'error' && entry.message.includes('could not timeout'),
    );
    expect(errored?.message).toContain('Timeout Members');
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

describe('phishing alert reports what actually happened', () => {
  async function alerted(
    config: Partial<PhishingConfig>,
    results: RecordingExecutor['results'] = {},
    messageId?: string,
  ): Promise<{ content: string; key: string; logs: CapturedLog[] }> {
    const harness = context({ alertChannel: ALERT_CHANNEL, ...config });
    harness.executor.results = results;

    await listener(loaded()).handler(
      messageEvent({
        content: `https://${BAD_DOMAIN}/gift`,
        ...(messageId ? { id: messageId } : {}),
      }),
      harness.ctx,
    );

    const send = harness.executor.of('send');
    return {
      content: String(payloadOf(send).content),
      key: send?.idempotencyKey ?? '',
      logs: harness.logs,
    };
  }

  const refusedTimeout: RecordingExecutor['results'] = {
    timeout: {
      status: 'failed_precheck',
      failure: {
        code: 'missing_permission',
        humanReason: "I'm missing the Timeout Members permission in this server.",
      },
    },
  };

  test('a timeout that went through keeps the action line word for word', async () => {
    const { content } = await alerted({});

    expect(content).toContain(
      `Action: timed out for 1h. If the link is safe, add \`${BAD_DOMAIN}\` to Allowed domains ` +
        'in the Proton dashboard.',
    );
  });

  test('a ban that went through says banned', async () => {
    const { content } = await alerted({ action: 'ban' });
    expect(content).toContain('Action: banned. If the link is safe');
  });

  test('a refused timeout says nothing was done and names the missing permission', async () => {
    const { content } = await alerted({}, refusedTimeout);

    expect(content).toContain(
      "No action was taken because the timeout failed. I'm missing the Timeout Members permission in " +
        'this server. If the link is safe',
    );
    expect(content).not.toContain('Action: timed out');
  });

  test('a ban Discord refused is not reported as a ban', async () => {
    const { content } = await alerted(
      { action: 'ban' },
      {
        ban: {
          status: 'failed_api',
          failure: {
            code: 'discord_403',
            humanReason:
              "Discord wouldn't let me do that. It is normally a permission I'm missing, or a " +
              'role ranked above mine.',
          },
        },
      },
    );

    expect(content).toContain(
      "No action was taken because the ban failed. Discord wouldn't let me",
    );
    expect(content).not.toContain('Action: banned');
  });

  test('a precheck failure with no reason attached still says nothing was done', async () => {
    const { content } = await alerted({ action: 'kick' }, { kick: { status: 'failed_precheck' } });
    expect(content).toContain(
      'No action was taken because the kick failed. No reason was reported.',
    );
  });

  test('a ban Discord could not find is a definite refusal', async () => {
    const { content } = await alerted(
      { action: 'ban' },
      {
        ban: {
          status: 'failed_api',
          failure: {
            code: 'discord_404',
            humanReason: "I couldn't find what that was meant to act on.",
          },
        },
      },
    );

    expect(content).toContain(
      "No action was taken because the ban failed. I couldn't find what that was meant to act on.",
    );
  });

  test('a ban on an author who left, through an executor that cannot ban a non-member, points at the ban list', async () => {
    const { content } = await alerted(
      { action: 'ban' },
      {
        ban: {
          status: 'failed_precheck',
          failure: { code: 'target_not_member', humanReason: "That user isn't in this server." },
        },
      },
    );

    expect(content).toContain(
      "they left or were removed first. If they're not on the ban list, ban them by hand so " +
        "they can't rejoin. If the link is safe",
    );
  });

  test('a kick that never reached Discord is not reported as not taken', async () => {
    const { content } = await alerted(
      { action: 'kick' },
      {
        kick: {
          status: 'failed_api',
          failure: {
            code: 'transport_failure',
            humanReason:
              "I couldn't reach Discord. That may not have gone through — check before trying again.",
          },
        },
      },
    );

    expect(content).toContain(
      "It's unclear whether the kick went through. I couldn't reach Discord. That may not have " +
        'gone through — check before trying again. If the link is safe',
    );
    expect(content).not.toContain('No action was taken');
    expect(content).not.toContain('Action: kicked');
  });

  test('a ban Discord answered with a 5xx is not reported as not taken', async () => {
    const { content } = await alerted(
      { action: 'ban' },
      {
        ban: {
          status: 'failed_api',
          failure: {
            code: 'discord_502',
            humanReason: 'Discord is having trouble right now, so that may not have gone through.',
          },
        },
      },
    );

    expect(content).toContain(
      "It's unclear whether the ban went through. Discord is having trouble right now, so that " +
        'may not have gone through.',
    );
    expect(content).not.toContain('No action was taken');
    expect(content).not.toContain('Action: banned');
  });

  test('a rate-limited timeout is not reported as a definite refusal either', async () => {
    const { content } = await alerted(
      {},
      {
        timeout: {
          status: 'failed_api',
          failure: {
            code: 'discord_429',
            humanReason: 'Discord is rate-limiting Proton right now, so that did not go through.',
          },
        },
      },
    );

    expect(content).toContain(
      "It's unclear whether the timeout went through, because Discord was rate limiting Proton at " +
        "the time. Check, and take the action by hand if it didn't apply. If the link is safe",
    );
    expect(content).not.toContain('No action was taken');
  });

  test('a rate-limited alert never repeats the executor’s sentence', async () => {
    const { content } = await alerted(
      { action: 'ban' },
      {
        ban: {
          status: 'failed_api',
          failure: {
            code: 'discord_429',
            humanReason: 'Discord is rate-limiting Proton right now, so that did not go through.',
          },
        },
      },
    );

    expect(content).toContain("It's unclear whether the ban went through, because Discord was");
    expect(content).not.toContain('did not go through');
    expect(content).not.toContain('retry');
  });

  const memberGone = (kind: 'kick' | 'ban' | 'timeout'): RecordingExecutor['results'] => ({
    [kind]: {
      status: 'failed_precheck',
      failure: {
        code: 'target_state_unavailable',
        humanReason:
          "I couldn't look up that member's roles, so I can't confirm I'm allowed to act on them, " +
          'and nothing was changed. Try again in a moment.',
      },
    },
  });

  test('a kick whose member lookup failed neither claims they are gone nor that nothing was done', async () => {
    const { content, key } = await alerted({ action: 'kick' }, memberGone('kick'));

    expect(content).toContain(
      "Couldn't confirm they're still in this server. The kick may already have gone through, " +
        "they may have left or been removed, or Discord couldn't be reached to check. If they're " +
        'still here, kick them by hand. If the link is safe',
    );
    expect(content).not.toContain('no longer in this server');
    expect(content).not.toContain('No action was taken');
    expect(content).not.toContain('Action: kicked');
    expect(content).not.toContain("couldn't look up");
    expect(key.endsWith(':alert:not-taken')).toBe(true);
  });

  test('a ban whose member lookup failed points at the ban list', async () => {
    const { content } = await alerted({ action: 'ban' }, memberGone('ban'));

    expect(content).toContain(
      "Couldn't confirm they're still in this server. The ban may already have gone through, " +
        "they may have left or been removed, or Discord couldn't be reached to check. If they're " +
        "not on the ban list, ban them by hand so they can't rejoin. If the link is safe",
    );
    expect(content).not.toContain('no longer in this server');
    expect(content).not.toContain('No action was taken');
    expect(content).not.toContain('Action: banned');
  });

  test('a timeout whose member lookup failed did not go through — a timeout never removes anyone', async () => {
    const { content } = await alerted({}, memberGone('timeout'));

    expect(content).toContain('No action was taken because the timeout failed.');
    expect(content).not.toContain("Couldn't confirm");
  });

  test('a kick Discord answers 404 may have landed on the transport retry, so it is not "No action"', async () => {
    const { content } = await alerted(
      { action: 'kick' },
      {
        kick: {
          status: 'failed_api',
          failure: { code: 'discord_404', humanReason: 'Unknown Member.', discordCode: 10007 },
        },
      },
    );

    expect(content).toContain(
      "Discord says they're no longer in this server, so either the kick already went through, " +
        'or they left or were removed first. If the link is safe',
    );
    expect(content).not.toContain('No action was taken');
    expect(content).not.toContain('Unknown Member.');
  });

  test('a kick answered by a 404 Discord did not send never says they are gone, nor that nothing was done', async () => {
    const { content } = await alerted(
      { action: 'kick' },
      {
        kick: {
          status: 'failed_api',
          failure: { code: 'discord_404', humanReason: 'Discord could not find it.' },
        },
      },
    );

    expect(content).toContain(
      "It's unclear whether the kick went through. Discord could not find it. If the link is safe",
    );
    expect(content).not.toContain('no longer in this server');
    expect(content).not.toContain('No action was taken');
  });

  test('a kick whose member lookup failed is logged as a warning that matches the alert', async () => {
    const { logs } = await alerted({ action: 'kick' }, memberGone('kick'));

    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
    const warned = logs.find((entry) => entry.message.includes('could not confirm'));
    expect(warned?.level).toBe('warn');
    expect(warned?.message).toContain(
      `could not confirm ${AUTHOR} is still in the server, so the kick may already have gone through`,
    );
  });

  test('a kick refused outright, or a timeout whose lookup failed, is still logged as an error', async () => {
    const refusedKick = await alerted(
      { action: 'kick' },
      {
        kick: {
          status: 'failed_api',
          failure: { code: 'discord_403', humanReason: 'Missing Permissions.' },
        },
      },
    );
    const lostTimeout = await alerted({}, memberGone('timeout'));

    expect(refusedKick.logs.find((entry) => entry.level === 'error')?.message).toContain(
      `could not kick ${AUTHOR}: Missing Permissions.`,
    );
    expect(lostTimeout.logs.find((entry) => entry.level === 'error')?.message).toContain(
      `could not timeout ${AUTHOR}`,
    );
  });

  test('a ban that went through says Discord deletes the message with it', async () => {
    const landed: RecordingExecutor['results'][] = [{}, { ban: { status: 'skipped_duplicate' } }];

    for (const results of landed) {
      const { content } = await alerted({ action: 'ban' }, results, recentMessageId());

      expect(content).toContain(
        '(Discord deletes it with the ban, along with their other messages from the last 24 ' +
          'hours)\nAction: banned.',
      );
      expect(content).not.toContain('still up');
    }
  });

  test('a ban leaves a message older than its 24-hour sweep up, as when a link is edited in', async () => {
    const { content } = await alerted({ action: 'ban' }, {}, recentMessageId(25 * 60 * 60 * 1000));
    expect(content).toContain('(still up, so delete it by hand)\nAction: banned.');
  });

  test('a ban that may have gone through says the message is deleted only if it did', async () => {
    const uncertain: RecordingExecutor['results'][] = [
      memberGone('ban'),
      { ban: { status: 'failed_api', failure: { code: 'discord_502', humanReason: 'x' } } },
      { ban: { status: 'failed_api', failure: { code: 'discord_429', humanReason: 'x' } } },
    ];

    for (const results of uncertain) {
      const { content } = await alerted({ action: 'ban' }, results, recentMessageId());
      expect(content).toContain('(deleted if the ban went through; if not, delete it by hand)\n');
    }
  });

  test('a refused ban or dry run, and any kick, leaves the message up', async () => {
    const refusedBan = await alerted(
      { action: 'ban' },
      { ban: { status: 'failed_api', failure: { code: 'discord_403', humanReason: 'x' } } },
      recentMessageId(),
    );
    const dryBan = await alerted(
      { action: 'ban' },
      { ban: { status: 'dry_run' } },
      recentMessageId(),
    );
    const kick = await alerted({ action: 'kick' }, {}, recentMessageId());

    expect(refusedBan.content).toContain(
      '(still up, so delete it by hand)\nNo action was taken because the ban failed.',
    );
    expect(dryBan.content).toContain('(still up, so delete it by hand)\nNo action was taken');
    expect(kick.content).toContain('(still up, so delete it by hand)\nAction: kicked.');
  });

  test('a kick refused for any other reason still says nothing was done', async () => {
    const { content } = await alerted(
      { action: 'kick' },
      {
        kick: {
          status: 'failed_precheck',
          failure: { code: 'missing_permission', humanReason: 'x' },
        },
      },
    );

    expect(content).toContain('No action was taken because the kick failed. x');
  });

  test('a Discord failure with no code attached is unclear, not a refusal', async () => {
    const { content } = await alerted({ action: 'kick' }, { kick: { status: 'failed_api' } });
    expect(content).toContain(
      "It's unclear whether the kick went through. No reason was reported.",
    );
  });

  test('a redelivery the executor already carried out still reports the action', async () => {
    const { content } = await alerted({}, { timeout: { status: 'skipped_duplicate' } });
    expect(content).toContain('Action: timed out for 1h.');
  });

  test('a dry run is not reported as an action', async () => {
    const { content } = await alerted({ action: 'kick' }, { kick: { status: 'dry_run' } });

    expect(content).toContain('No action was taken because the kick was only a dry run.');
    expect(content).not.toContain('Action: kicked');
  });

  test('a zero timeout duration is reported as not taken, not as "timed out for 0s"', async () => {
    const harness = context({ alertChannel: ALERT_CHANNEL, timeoutDuration: '0m' });
    await listener(loaded()).handler(
      messageEvent({ content: `https://${BAD_DOMAIN}/gift` }),
      harness.ctx,
    );

    expect(harness.executor.of('timeout')).toBeUndefined();
    const content = String(payloadOf(harness.executor.of('send')).content);
    expect(content).toContain(
      "No action was taken because the timeout failed. '0m' isn't a valid timeout duration.",
    );
    expect(content).toContain('Fix the Timeout duration setting');
    expect(content).not.toContain('Action: timed out');
  });

  test('a failed attempt alerts under its own key, so a retry that lands still reports', async () => {
    const failed = await alerted({}, refusedTimeout);
    const failedAgain = await alerted({}, refusedTimeout);
    const landed = await alerted({});
    const replayed = await alerted({}, { timeout: { status: 'skipped_duplicate' } });

    expect(failedAgain.key).toBe(failed.key);
    expect(landed.key).not.toBe(failed.key);
    expect(replayed.key).toBe(landed.key);
  });
});

describe('phishing alerts once per message against the real executor', () => {
  const posted = messageEvent({ content: `https://${BAD_DOMAIN}/gift` });
  const unfurled = messageEvent({
    type: 'message.updated',
    content: `https://${BAD_DOMAIN}/gift`,
  });

  for (const [action, line] of [
    ['kick', 'Action: kicked.'],
    ['ban', 'Action: banned.'],
    ['timeout', 'Action: timed out for 1h.'],
  ] as const) {
    test(`a ${action} that went through, then the embed-unfurl redelivery, posts exactly one alert`, async () => {
      const { ctx, discord } = liveContext({ action, alertChannel: ALERT_CHANNEL });

      await listener(loaded()).handler(posted, ctx);
      await listener(loaded()).handler(unfurled, ctx);

      expect(discord.memberCalls()).toHaveLength(1);
      expect(discord.alerts()).toHaveLength(1);
      expect(discord.alerts()[0]).toContain(line);
      expect(discord.alerts()[0]).not.toContain('No action was taken');
    });
  }

  test('a refused kick, then a redelivery that lands, reports the refusal and then the kick', async () => {
    const { ctx, discord } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.refuseRemovalWith = { status: 403, body: { message: 'Missing Permissions' } };

    await listener(loaded()).handler(posted, ctx);
    discord.refuseRemovalWith = null;
    await listener(loaded()).handler(unfurled, ctx);
    await listener(loaded()).handler(unfurled, ctx);

    expect(discord.memberCalls()).toHaveLength(2);
    expect(discord.alerts()).toHaveLength(2);
    expect(discord.alerts()[0]).toContain('No action was taken because the kick failed.');
    expect(discord.alerts()[1]).toContain('Action: kicked.');
  });
});

describe('phishing alerts truthfully when the member is gone or Discord rate-limits', () => {
  const posted = messageEvent({ content: `https://${BAD_DOMAIN}/gift` });
  const unfurled = messageEvent({
    type: 'message.updated',
    content: `https://${BAD_DOMAIN}/gift`,
  });

  for (const action of ['kick', 'ban'] as const) {
    test(`a ${action} on a member who is already gone is unconfirmed, not "No action"`, async () => {
      const { ctx, discord } = liveContext({ action, alertChannel: ALERT_CHANNEL });
      discord.removed.add(AUTHOR);

      await listener(loaded()).handler(posted, ctx);

      expect(discord.memberCalls()).toHaveLength(0);
      expect(discord.alerts()).toHaveLength(1);
      expect(discord.alerts()[0]).toContain(
        `Couldn't confirm they're still in this server. The ${action} may already have gone ` +
          'through',
      );
      expect(discord.alerts()[0]).not.toContain('No action was taken');
    });

    test(`a ${action} whose member lookup fails while they are still here never says they are gone`, async () => {
      const { ctx, discord, logs } = liveContext({ action, alertChannel: ALERT_CHANNEL });
      discord.memberLookupFails = true;

      await listener(loaded()).handler(posted, ctx);

      expect(discord.memberCalls()).toHaveLength(0);
      expect(discord.removed.has(AUTHOR)).toBe(false);
      expect(discord.alerts()).toHaveLength(1);
      expect(discord.alerts()[0]).not.toContain('no longer in this server');
      expect(discord.alerts()[0]).toContain("or Discord couldn't be reached to check.");
      expect(discord.alerts()[0]).toContain(
        action === 'kick'
          ? "If they're still here, kick them by hand."
          : "If they're not on the ban list, ban them by hand",
      );
      expect(logs.find((entry) => entry.message.includes('could not confirm'))?.level).toBe('warn');
    });
  }

  test('a kick on a member Discord says is not in the server says they are gone, not "could not confirm"', async () => {
    const { ctx, discord, logs } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.removed.add(AUTHOR);
    discord.lookupSaysNotMember = true;

    await listener(loaded()).handler(posted, ctx);

    expect(discord.memberCalls()).toHaveLength(0);
    expect(discord.alerts()).toHaveLength(1);
    expect(discord.alerts()[0]).toContain(
      "Discord says they're no longer in this server, so either the kick already went " +
        'through, or they left or were removed first.',
    );
    expect(discord.alerts()[0]).not.toContain("Couldn't confirm");
    expect(discord.alerts()[0]).not.toContain('No action was taken');
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
    expect(logs.find((entry) => entry.message.includes('is no longer in the server'))?.level).toBe(
      'warn',
    );
  });

  test('a ban on an author Discord says already left bans nobody by ID and points at the ban list', async () => {
    const { ctx, discord, logs } = liveContext({ action: 'ban', alertChannel: ALERT_CHANNEL });
    discord.removed.add(AUTHOR);
    discord.lookupSaysNotMember = true;

    await listener(loaded()).handler(posted, ctx);

    expect(discord.memberCalls()).toHaveLength(0);
    expect(discord.alerts()).toHaveLength(1);
    expect(discord.alerts()[0]).toContain(
      "Discord says they're no longer in this server, so either the ban already went through, " +
        "or they left or were removed first. If they're not on the ban list, ban them by hand",
    );
    expect(discord.alerts()[0]).not.toContain('No action was taken');
    expect(discord.alerts()[0]).not.toContain('Action: banned');
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  test('a timeout on a member Discord says is not in the server still says nothing was done', async () => {
    const { ctx, discord } = liveContext({ alertChannel: ALERT_CHANNEL });
    discord.removed.add(AUTHOR);
    discord.lookupSaysNotMember = true;

    await listener(loaded()).handler(posted, ctx);

    expect(discord.alerts()[0]).toContain('No action was taken because the timeout failed.');
    expect(discord.alerts()[0]).not.toContain("Discord says they're no longer");
  });

  test('a kick Discord answers 404 with another code is a refusal, not a member who is gone', async () => {
    const { ctx, discord } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.refuseRemovalWith = { status: 404, body: { message: 'Unknown Guild', code: 10004 } };

    await listener(loaded()).handler(posted, ctx);

    expect(discord.alerts()[0]).toContain('No action was taken because the kick failed.');
    expect(discord.alerts()[0]).not.toContain('no longer in this server');
  });

  test('a timeout on a member who is already gone still says nothing was done', async () => {
    const { ctx, discord } = liveContext({ alertChannel: ALERT_CHANNEL });
    discord.removed.add(AUTHOR);

    await listener(loaded()).handler(posted, ctx);

    expect(discord.memberCalls()).toHaveLength(0);
    expect(discord.alerts()[0]).toContain('No action was taken because the timeout failed.');
  });

  test('a kick that landed but whose answer the proxy lost, then the unfurl redelivery, never says "No action"', async () => {
    const { ctx, discord, logs } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.removeThenAnswer = {
      status: 502,
      body: { error: 'rest_proxy_upstream_failure', message: 'The operation was aborted' },
    };

    await listener(loaded()).handler(posted, ctx);
    await listener(loaded()).handler(unfurled, ctx);

    expect(discord.memberCalls()).toHaveLength(1);
    expect(discord.alerts()).toHaveLength(1);
    expect(discord.alerts()[0]).toContain("It's unclear whether the kick went through.");
    expect(discord.alerts()[0]).not.toContain('No action was taken');
    expect(
      logs.filter((entry) => entry.level === 'error' && entry.message.includes('could not kick')),
    ).toHaveLength(1);
    expect(logs.find((entry) => entry.message.includes('could not confirm'))?.level).toBe('warn');
  });

  test('a kick that landed before the connection to the proxy dropped is unclear too', async () => {
    const { ctx, discord } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.removeThenAnswer = new Error('socket connection was closed unexpectedly');

    await listener(loaded()).handler(posted, ctx);
    await listener(loaded()).handler(unfurled, ctx);

    expect(discord.memberCalls()).toHaveLength(1);
    expect(discord.alerts()).toHaveLength(1);
    expect(discord.alerts()[0]).toContain("It's unclear whether the kick went through.");
    expect(discord.alerts()[0]).not.toContain('No action was taken');
  });

  test.each([
    ['Unknown Member', 10007],
    ['Unknown User', 10013],
  ])('a kick Discord answers 404 %s says they are gone, not "No action"', async (message, code) => {
    const { ctx, discord } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.refuseRemovalWith = { status: 404, body: { message, code } };

    await listener(loaded()).handler(posted, ctx);

    expect(discord.memberCalls()).toHaveLength(1);
    expect(discord.alerts()[0]).toContain(
      "Discord says they're no longer in this server, so either the kick already went through, " +
        'or they left or were removed first. If the link is safe',
    );
    expect(discord.alerts()[0]).not.toContain('No action was taken');
  });

  test('a ban that went through on a fresh message says Discord deletes it', async () => {
    const { ctx, discord } = liveContext({ action: 'ban', alertChannel: ALERT_CHANNEL });

    await listener(loaded()).handler(
      messageEvent({ id: recentMessageId(), content: `https://${BAD_DOMAIN}/gift` }),
      ctx,
    );

    expect(discord.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
      delete_message_seconds: 86_400,
    });
    expect(discord.alerts()[0]).toContain('(Discord deletes it with the ban');
    expect(discord.alerts()[0]).not.toContain('still up');
  });

  test('a ban Discord answers 404 Unknown User is still a refusal', async () => {
    const { ctx, discord } = liveContext({ action: 'ban', alertChannel: ALERT_CHANNEL });
    discord.refuseRemovalWith = { status: 404, body: { message: 'Unknown User', code: 10013 } };

    await listener(loaded()).handler(posted, ctx);

    expect(discord.alerts()[0]).toContain('No action was taken because the ban failed.');
  });

  test('a rate-limited kick alerts in phishing wording, with nothing of the executor appended', async () => {
    const { ctx, discord } = liveContext({ action: 'kick', alertChannel: ALERT_CHANNEL });
    discord.refuseRemovalWith = {
      status: 429,
      body: { message: 'You are being rate limited.', retry_after: 1.5, global: false },
    };

    await listener(loaded()).handler(posted, ctx);

    expect(discord.alerts()).toHaveLength(1);
    expect(discord.alerts()[0]).toContain(
      "It's unclear whether the kick went through, because Discord was rate limiting Proton at " +
        "the time. Check, and take the action by hand if it didn't apply. If the link is safe",
    );
    expect(discord.alerts()[0]).not.toContain('retry');
    expect(discord.alerts()[0]).not.toContain('No action was taken');
  });
});
