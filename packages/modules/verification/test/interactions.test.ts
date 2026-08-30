import { describe, expect, test } from 'bun:test';
import { Permissions, readVerifyLink } from '@proton/core';
import {
  ABOVE_BOT_ROLE,
  BARE,
  CAPTCHA,
  captchaPress,
  EVERYONE_ROLE,
  GATED,
  GUILD,
  harness,
  MEMBER,
  refreshPress,
  UNVERIFIED_ROLE,
  VERIFIED_ROLE,
  VERIFY_LINK_BASE_URL,
  VERIFY_LINK_SECRET,
  verifyPress,
  WEBSITE,
} from './harness.ts';

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

function tokenOf(url: string): string {
  return url.slice(`${VERIFY_LINK_BASE_URL}/verify/`.length);
}

describe('the panel button in button mode', () => {
  test('grants the member role and takes the unverified one away', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    const outcome = await h.press(verifyPress(), { config: GATED });

    expect(outcome).toEqual({ action: 'verified' });
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, VERIFIED_ROLE]));
    expect(h.lastTold()).toContain("You're verified");
  });

  test('acknowledges the press before it touches a role, so Discord does not time out', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: GATED });

    expect(h.callbackTypes()).toEqual([5]);
    expect(h.rest.calls[0]?.path).toContain('/interactions/');
  });

  test('tells an already-verified member so, and executes nothing at all', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, VERIFIED_ROLE]));

    const outcome = await h.press(verifyPress(), { config: GATED });

    expect(outcome).toEqual({
      action: 'refused',
      reason: 'the member already holds the member role',
    });
    expect(h.lastTold()).toContain("You're already verified");
    expect(h.callbackTypes()).toEqual([4]);
    expect(h.roleCalls()).toEqual([]);
    expect(h.cases()).toEqual([]);
  });

  test('honours the mode config carries now, not the one the panel was posted under', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), { config: CAPTCHA });

    expect(outcome.action).toBe('challenged');
    expect(h.roleCalls()).toEqual([]);
  });

  test('answers a press while verification is switched off instead of ignoring it', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), { config: { ...GATED, enabled: false } });

    expect(outcome.action).toBe('refused');
    expect(h.lastTold()).toContain('switched off');
    expect(h.roleCalls()).toEqual([]);
  });

  test('leaves another module’s component alone', async () => {
    const h = harness();

    const outcome = await h.press('proton:tickets:open', { config: GATED });

    expect(outcome).toEqual({ action: 'ignored', reason: 'another module owns that component' });
    expect(h.rest.calls).toEqual([]);
  });
});

describe('a press the bot cannot honour (the permission-failure path)', () => {
  test('refuses before touching a role when the member role sits above the bot', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    const outcome = await h.press(verifyPress(), {
      config: { ...GATED, verifiedRoleId: ABOVE_BOT_ROLE },
    });

    expect(outcome.action).toBe('refused');
    expect(h.roleCalls()).toEqual([]);
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    expect(h.lastTold()).toContain('position 9');
    expect(h.lastTold()).toContain('position 6');
    expect(h.lastTold()).toContain("Drag Proton's role above it");
  });

  test('names the missing permission and where, when the bot cannot move roles at all', async () => {
    const h = harness({ botPermissions: Permissions.ViewChannel | Permissions.SendMessages });
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));

    const outcome = await h.press(verifyPress(), { config: GATED });

    expect(outcome.action).toBe('refused');
    expect(h.lastTold()).toContain('Manage Roles');
    expect(h.lastTold()).toContain('this server');
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, UNVERIFIED_ROLE]));
  });

  test('a refused grant leaves the member exactly where they were', async () => {
    const h = harness();
    h.memberRoles.set(MEMBER, new Set([EVERYONE_ROLE, UNVERIFIED_ROLE]));
    h.rest.fail((call) => call.method === 'PUT' && call.path.endsWith(`/roles/${VERIFIED_ROLE}`), {
      status: 500,
      body: { message: 'Internal Server Error' },
    });

    const outcome = await h.press(verifyPress(), { config: GATED });

    expect(outcome.action).toBe('refused');
    expect(h.lastTold()).toContain('nothing has changed');
    expect(sorted(h.rolesOf(MEMBER))).toEqual(sorted([EVERYONE_ROLE, UNVERIFIED_ROLE]));
  });
});

describe('the panel button in website mode', () => {
  test('hands back a link button, and no role until the website says so', async () => {
    const h = harness();

    const outcome = await h.press(verifyPress(), { config: WEBSITE });

    expect(outcome).toEqual({ action: 'linked' });
    expect(h.roleCalls()).toEqual([]);

    const link = h.button('Verify');
    expect(link.customId).toBeNull();
    expect(link.url).toStartWith(`${VERIFY_LINK_BASE_URL}/verify/`);
  });

  test('the link carries a token this deployment accepts for this guild and this member', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: WEBSITE });
    const result = await readVerifyLink(tokenOf(h.button('Verify').url ?? ''), VERIFY_LINK_SECRET);

    if ('invalid' in result) throw new Error(result.invalid);
    expect(result.claims.guildId).toBe(GUILD);
    expect(result.claims.userId).toBe(MEMBER);
  });

  test('a token minted for one member never reads back as another', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: WEBSITE, userId: BARE });
    const result = await readVerifyLink(tokenOf(h.button('Verify').url ?? ''), VERIFY_LINK_SECRET);

    if ('invalid' in result) throw new Error(result.invalid);
    expect(result.claims.userId).toBe(BARE);
    expect(result.claims.userId).not.toBe(MEMBER);
  });

  test('a token signed for a different deployment is refused without saying why', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: WEBSITE });
    const result = await readVerifyLink(
      tokenOf(h.button('Verify').url ?? ''),
      'another-deployment-secret-of-at-least-32-chars',
    );

    expect('invalid' in result).toBe(true);
  });
});

describe('a deployment that was never fully wired', () => {
  const modes = [
    { config: GATED, what: 'button' },
    { config: CAPTCHA, what: 'captcha' },
    { config: WEBSITE, what: 'website' },
  ];

  for (const mode of modes) {
    test(`answers a ${mode.what} press instead of leaving it spinning`, async () => {
      const h = harness();

      const outcome = await h.press(verifyPress(), { config: mode.config, deps: {} });

      expect(outcome.action).toBe('refused');
      expect(h.lastTold()).toContain('not anything you did');
      expect(h.roleCalls()).toEqual([]);
    });
  }

  test('answers the captcha follow-up presses too', async () => {
    const h = harness();
    const challenge = await h.seed();

    for (const press of [captchaPress, refreshPress]) {
      const outcome = await h.press(press(challenge.challengeId), {
        config: CAPTCHA,
        deps: {},
      });

      expect(outcome.action).toBe('refused');
    }

    expect(h.told()).toHaveLength(2);
    expect(h.told().every((content) => content.includes('not anything you did'))).toBe(true);
  });

  test('names the port the deployment forgot, in the log, for the admin who has to fix it', async () => {
    const h = harness();

    await h.press(verifyPress(), { config: GATED, deps: {} });

    const error = h.logs.find((entry) => entry.level === 'error');
    expect(error?.message).toContain('guildState, applicationId');
    expect(error?.message).toContain('RedisGuildStateStore');
    expect(error?.message).toContain("the application's own id");
    expect(error?.message).toContain('createVerificationModule');
  });
});
