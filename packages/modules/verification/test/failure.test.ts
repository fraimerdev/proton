import { describe, expect, test } from 'bun:test';
import { MAX_TIMEOUT_MS } from '@proton/core';
import type { VerificationConfig } from '../src/config.ts';
import { verificationDefaultConfig } from '../src/config.ts';
import { planFailure } from '../src/failure.ts';
import {
  answerModal,
  CAPTCHA,
  EVERYONE_ROLE,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  QUARANTINE_ROLE,
  UNVERIFIED_ROLE,
} from './harness.ts';

const CODE = 'code';

const LAST_CHANCE = { ...CAPTCHA, captchaAttempts: 1 };

async function spendTheLastAttempt(h: Harness, config: Partial<VerificationConfig>): Promise<void> {
  const challenge = await h.seed();
  await h.submit(answerModal(challenge.challengeId), { [CODE]: 'WRONG1' }, { config });
}

describe('running out of attempts', () => {
  test('does nothing but offer a fresh start when no failure action is set', async () => {
    const h = harness();

    await spendTheLastAttempt(h, LAST_CHANCE);

    expect(h.lastTold()).toContain('You are out of attempts.');
    expect(h.lastTold()).toContain('Press Verify to start over');
    expect(h.discordCalls()).toEqual([]);
    expect(await h.captcha.get(GUILD, MEMBER)).toBeNull();
  });

  test('kicks the member when that is the configured action', async () => {
    const h = harness();

    await spendTheLastAttempt(h, { ...LAST_CHANCE, failureAction: 'kick' });

    expect(h.discordCalls()).toHaveLength(1);
    expect(h.discordCalls()[0]?.method).toBe('DELETE');
    expect(h.discordCalls()[0]?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
    expect(h.lastTold()).toContain('removed from the server');
  });

  test('bans the member without sweeping their history when that is the action', async () => {
    const h = harness();

    await spendTheLastAttempt(h, { ...LAST_CHANCE, failureAction: 'ban' });

    expect(h.discordCalls()[0]?.method).toBe('PUT');
    expect(h.discordCalls()[0]?.path).toBe(`/guilds/${GUILD}/bans/${MEMBER}`);
    expect(h.discordCalls()[0]?.body).toEqual({ delete_message_seconds: 0 });
  });

  test('times the member out for the configured length', async () => {
    const h = harness();

    await spendTheLastAttempt(h, {
      ...LAST_CHANCE,
      failureAction: 'timeout',
      failureTimeout: '30m',
    });

    const call = h.discordCalls()[0];
    const body = call?.body as { communication_disabled_until?: string } | undefined;

    expect(call?.method).toBe('PATCH');
    expect(call?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
    expect(Date.parse(body?.communication_disabled_until ?? '')).toBe(h.now() + 30 * 60 * 1000);
    expect(h.lastTold()).toContain('timed out for 30m');
  });

  test('quarantines the member with the role quarantine already uses', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    await spendTheLastAttempt(h, {
      ...LAST_CHANCE,
      failureAction: 'quarantine',
      quarantineRoleId: QUARANTINE_ROLE,
    });

    expect(h.rolesOf(MEMBER)).toContain(QUARANTINE_ROLE);
    expect(h.lastTold()).toContain('access has been restricted');
  });

  test('refuses to quarantine with no role chosen, naming the setting and the page', async () => {
    const h = harness();

    await spendTheLastAttempt(h, { ...LAST_CHANCE, failureAction: 'quarantine' });

    expect(h.discordCalls()).toEqual([]);

    const error = h.logs.find((entry) => entry.level === 'error');
    expect(error?.message).toContain('Quarantine role');
    expect(error?.message).toContain('Proton dashboard');
    expect(h.lastTold()).toContain('You are out of attempts.');
  });

  test('tells the member before the kick lands — a kick closes the only channel it has', async () => {
    const h = harness();

    await spendTheLastAttempt(h, { ...LAST_CHANCE, failureAction: 'kick' });

    const told = h.rest.calls.findIndex((call) => call.path.startsWith('/interactions/'));
    const kicked = h.rest.calls.findIndex((call) => call.method === 'DELETE');

    expect(told).toBeGreaterThanOrEqual(0);
    expect(told).toBeLessThan(kicked);
  });

  test('fires the failure action once, not once per press that follows it', async () => {
    const h = harness();
    const challenge = await h.seed();
    const config: Partial<VerificationConfig> = { ...LAST_CHANCE, failureAction: 'kick' };

    await h.submit(answerModal(challenge.challengeId), { [CODE]: 'WRONG1' }, { config });
    const outcome = await h.submit(
      answerModal(challenge.challengeId),
      { [CODE]: 'WRONG2' },
      { config },
    );

    expect(outcome.action).toBe('refused');
    expect(h.discordCalls().filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('still answers the member truthfully when Discord refuses the kick', async () => {
    const h = harness();
    h.rest.fail((call) => call.path === `/guilds/${GUILD}/members/${MEMBER}`, {
      status: 403,
      body: { message: 'Missing Permissions' },
    });

    await spendTheLastAttempt(h, { ...LAST_CHANCE, failureAction: 'kick' });

    expect(h.lastTold()).toContain('removed from the server');

    const error = h.logs.find((entry) => entry.level === 'error');
    expect(error?.message).toContain(MEMBER);
    expect(error?.message).toContain('kicked');
    expect(error?.message).toContain("Discord wouldn't let me do that");
  });
});

describe('planFailure', () => {
  const config = { ...verificationDefaultConfig, quarantineRoleId: QUARANTINE_ROLE };
  const NOW = 1_700_000_000_000;

  test('plans nothing at all for the default action', () => {
    expect(planFailure(config, MEMBER, NOW)).toBeNull();
  });

  test('caps a timeout at the 28 days Discord allows, rather than being refused outright', () => {
    const result = planFailure(
      { ...config, failureAction: 'timeout', failureTimeout: '9w' },
      MEMBER,
      NOW,
    );

    if (result === null || 'unconfigured' in result) throw new Error('expected a plan');
    const payload = result.plan.payload as { until: Date };

    expect(payload.until.getTime()).toBe(NOW + MAX_TIMEOUT_MS);
    expect(result.plan.told).toContain('4w');
  });

  test('names the setting when the stored timeout length is not a length at all', () => {
    const result = planFailure(
      { ...config, failureAction: 'timeout', failureTimeout: 'soon' },
      MEMBER,
      NOW,
    );

    if (result === null || !('unconfigured' in result)) throw new Error('expected a refusal');
    expect(result.unconfigured).toContain('Timeout length');
    expect(result.unconfigured).toContain("'soon'");
    expect(result.unconfigured).toContain('Proton dashboard');
  });

  test('names the quarantine role setting when the action has no role to apply', () => {
    const result = planFailure(
      { ...verificationDefaultConfig, failureAction: 'quarantine' },
      MEMBER,
      NOW,
    );

    if (result === null || !('unconfigured' in result)) throw new Error('expected a refusal');
    expect(result.unconfigured).toContain('Verification → Quarantine role');
  });
});
