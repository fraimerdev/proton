import { describe, expect, test } from 'bun:test';
import { DM_ATTEMPTS_MAX } from '../src/store.ts';
import { armed, DM_CHANNEL, GUILD, harness, LOG, MEMBER, MESSAGE, TRAP } from './harness.ts';

const TELLS = armed({ sendDirectMessage: true });

function texts(nodes: readonly Record<string, unknown>[]): string[] {
  return nodes.flatMap((node) =>
    node.type === 10
      ? [String(node.content)]
      : texts(Array.isArray(node.components) ? (node.components as Record<string, unknown>[]) : []),
  );
}

function buttons(nodes: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return nodes.flatMap((node) =>
    node.type === 2
      ? [node]
      : buttons(
          Array.isArray(node.components) ? (node.components as Record<string, unknown>[]) : [],
        ),
  );
}

describe('telling the member', () => {
  test('opens a direct message and sends into it', async () => {
    const h = harness();

    await h.trip({ config: TELLS });

    expect(h.calls()).toContain('POST /users/@me/channels');
    expect(h.sentIn(DM_CHANNEL)).toHaveLength(1);
  });

  // After a ban there is no shared server left to send it through, so telling them afterwards is
  // telling nobody.
  test('sends it before the ban, not after', async () => {
    const h = harness();

    await h.trip({ config: TELLS });

    const calls = h.calls();

    expect(calls.indexOf(`POST /channels/${DM_CHANNEL}/messages`)).toBeLessThan(
      calls.indexOf(`PUT /guilds/${GUILD}/bans/${MEMBER}`),
    );
  });

  test('says which server and what happened', async () => {
    const h = harness();

    await h.trip({ config: TELLS });

    const said = texts(
      (h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[],
    ).join('\n');

    expect(said).toContain('Test Guild');
    expect(said).toContain('removed from the server, and can rejoin straight away');
  });

  test('carries the recovery advice, because a caught account is usually a stolen one', async () => {
    const h = harness();

    await h.trip({ config: TELLS });

    const said = texts(
      (h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[],
    ).join('\n');

    expect(said).toContain('Change your password');
    expect(said).toContain('nobody reads replies');
  });

  test('mentions nobody', async () => {
    const h = harness();

    await h.trip({ config: TELLS });

    expect(h.sentIn(DM_CHANNEL)[0]?.allowed_mentions).toEqual({ parse: [] });
  });

  test('sends nothing at all when the server switched it off', async () => {
    const h = harness();

    await h.trip({ config: armed() });

    expect(h.calls()).not.toContain('POST /users/@me/channels');
  });
});

describe('the way back in', () => {
  test('is absent until a server offers one', async () => {
    const h = harness();

    await h.trip({ config: TELLS });

    expect(
      buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]),
    ).toEqual([]);
  });

  test('is a link button carrying the invite the admin pasted', async () => {
    const h = harness();

    await h.trip({
      config: armed({
        sendDirectMessage: true,
        offerWayBackIn: true,
        inviteUrl: 'https://discord.gg/example',
      }),
    });

    const found = buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]);

    expect(found).toHaveLength(1);
    expect(found[0]?.url).toBe('https://discord.gg/example');
  });

  test('is not offered when the toggle is on but no link was given', async () => {
    const h = harness();

    await h.trip({ config: armed({ sendDirectMessage: true, offerWayBackIn: true }) });

    expect(
      buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]),
    ).toEqual([]);
  });
});

describe('a member who cannot be reached', () => {
  test('is still acted on, and the log says they were not told', async () => {
    const h = harness();
    h.rest.fail((call) => call.path === '/users/@me/channels', {
      status: 403,
      body: { message: 'Cannot send messages to this user' },
    });

    const outcome = await h.trip({ config: { ...TELLS, logChannelId: LOG } });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(JSON.stringify(h.embedIn(LOG))).toContain('direct messages are closed');
  });
});

// The executor answers a redelivered open with skipped_duplicate and no body. Without the written
// -down channel id, a worker that died between the two calls would leave the member banned, never
// told, and with nothing to retry from.
describe('a worker that died between opening the channel and sending', () => {
  test('sends on the next attempt rather than losing the message forever', async () => {
    const h = harness();
    const root = `honeypot:${GUILD}:${MESSAGE}`;

    // What the first attempt would have written down before it died.
    await h.dms.remember(GUILD, root, DM_CHANNEL);

    await h.trip({ config: TELLS });

    expect(h.calls()).not.toContain('POST /users/@me/channels');
    expect(h.sentIn(DM_CHANNEL)).toHaveLength(1);
  });

  test('a fresh attempt opens under a new key rather than a bodiless duplicate', async () => {
    const h = harness();
    const root = `honeypot:${GUILD}:${MESSAGE}`;

    await h.trip({ config: TELLS });

    expect((await h.dms.recall(GUILD, root)).attempts).toBe(1);
    expect((await h.dms.recall(GUILD, root)).channelId).toBe(DM_CHANNEL);
  });

  test('gives up loudly rather than opening forever', async () => {
    const h = harness();
    const root = `honeypot:${GUILD}:${MESSAGE}`;

    h.dms.records.set(`${GUILD}:${root}`, { channelId: null, attempts: DM_ATTEMPTS_MAX });

    const outcome = await h.trip({ config: { ...TELLS, logChannelId: LOG } });

    expect(outcome).toEqual({ action: 'sprung', kind: 'softban' });
    expect(h.said('error').join(' ')).toContain('has given up');
    expect(JSON.stringify(h.embedIn(LOG))).toContain('were NOT told');
  });
});

describe('an exempt catch', () => {
  test('is never sent a direct message — nothing happened to them', async () => {
    const h = harness();

    await h.trip({
      config: armed({ sendDirectMessage: true, exemptRoleIds: [TRAP] }),
      roleIds: [TRAP],
    });

    expect(h.calls()).not.toContain('POST /users/@me/channels');
  });
});

describe('the appeal link', () => {
  const BANS = armed({ sendDirectMessage: true, action: 'ban', appealPanelId: 'ban-form' });

  test('is a link button on a real ban, pointing at this deployment', async () => {
    const h = harness();

    await h.trip({ config: BANS });

    const found = buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]);

    expect(found).toHaveLength(1);
    expect(String(found[0]?.url)).toStartWith('https://prtn.xyz/appeal/');
    expect(found[0]?.custom_id).toBeUndefined();
  });

  // A softban bans and lifts it in the same breath. An appeal button there invites somebody to
  // argue about something that is not stopping them.
  test('is absent on a softban, however the form is configured', async () => {
    const h = harness();

    await h.trip({ config: armed({ sendDirectMessage: true, appealPanelId: 'ban-form' }) });

    expect(
      buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]),
    ).toEqual([]);
  });

  test('is absent when no form is picked', async () => {
    const h = harness();

    await h.trip({ config: armed({ sendDirectMessage: true, action: 'ban' }) });

    expect(
      buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]),
    ).toEqual([]);
  });

  // Never a button that goes nowhere, and never a dropped message: the member is still told.
  test('is dropped, loudly, when the signing secret was never wired up', async () => {
    const h = harness({ link: false });

    await h.trip({ config: BANS });

    expect(
      buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[]),
    ).toEqual([]);
    expect(h.sentIn(DM_CHANNEL)).toHaveLength(1);
    expect(h.said('error').join(' ')).toContain('offered no appeal link');
  });

  // A RESUME redelivery must mint the same link, or one ban hands the member two different ones
  // and the appeal filed under the second is a second appeal.
  test('is byte-identical when the same catch is redelivered', async () => {
    const first = harness();
    const second = harness();

    await first.trip({ config: BANS });
    await second.trip({ config: BANS });

    const urlOf = (h: typeof first): unknown =>
      buttons((h.sentIn(DM_CHANNEL)[0]?.components ?? []) as Record<string, unknown>[])[0]?.url;

    expect(urlOf(first)).toBe(urlOf(second) as string);
  });
});
