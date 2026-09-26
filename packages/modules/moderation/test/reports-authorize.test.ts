import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { type ModerationConfig, moderationConfigSchema } from '../src/config.ts';
import {
  mayReview,
  mayUnclaim,
  type ReviewActor,
  validateReporter,
  validateTarget,
} from '../src/reports/authorize.ts';
import {
  GUILD,
  HIGH_ROLE,
  LOW_ROLE,
  MEMBER,
  MOD_ROLE,
  MODERATOR,
  OWNER,
  REPORTER,
} from './harness.ts';

function config(reports: Record<string, unknown> = {}): ModerationConfig {
  return moderationConfigSchema.parse({ reports: { enabled: true, ...reports } });
}

function reporter(roleIds: string[] | null = [], permissions: bigint | null = 0n) {
  return { id: REPORTER, roleIds, permissions };
}

describe('validateReporter', () => {
  test('everyone may report by default', () => {
    expect(validateReporter(config(), reporter(), GUILD)).toEqual({ ok: true });
  });

  test('the block list wins over every mode and Administrator', () => {
    const result = validateReporter(
      config({ blockedUserIds: [REPORTER] }),
      reporter([], Permissions.Administrator),
      GUILD,
    );
    expect(result).toMatchObject({ ok: false, code: 'blocked' });
  });

  test('"only" admits a listed role, @everyone, or Administrator', () => {
    const only = config({ reporters: { mode: 'only', roleIds: [MOD_ROLE] } });

    expect(validateReporter(only, reporter([LOW_ROLE]), GUILD)).toMatchObject({
      ok: false,
      code: 'not_allowed',
    });
    expect(validateReporter(only, reporter([MOD_ROLE]), GUILD)).toEqual({ ok: true });
    expect(validateReporter(only, reporter([], Permissions.Administrator), GUILD)).toEqual({
      ok: true,
    });

    const everyone = config({ reporters: { mode: 'only', roleIds: [GUILD] } });
    expect(validateReporter(everyone, reporter([]), GUILD)).toEqual({ ok: true });
  });

  test('"except" refuses a listed role', () => {
    const except = config({ reporters: { mode: 'except', roleIds: [HIGH_ROLE] } });

    expect(validateReporter(except, reporter([HIGH_ROLE]), GUILD)).toMatchObject({ ok: false });
    expect(validateReporter(except, reporter([LOW_ROLE]), GUILD)).toEqual({ ok: true });
  });

  test('unknown roles refuse a role mode instead of guessing', () => {
    const only = config({ reporters: { mode: 'only', roleIds: [MOD_ROLE] } });
    expect(validateReporter(only, reporter(null, null), GUILD)).toMatchObject({
      ok: false,
      code: 'roles_unknown',
    });
  });
});

describe('validateTarget', () => {
  const base = {
    reporterId: REPORTER,
    targetId: MEMBER,
    targetBot: false,
    targetRoleIds: [LOW_ROLE],
  };

  test('self, bots and immune roles are refused', () => {
    expect(validateTarget(config(), { ...base, targetId: REPORTER })).toMatchObject({
      code: 'self',
    });
    expect(validateTarget(config(), { ...base, targetBot: true })).toMatchObject({ code: 'bot' });
    expect(validateTarget(config({ immuneRoleIds: [LOW_ROLE] }), base)).toMatchObject({
      code: 'immune',
    });
    expect(validateTarget(config(), base)).toEqual({ ok: true });
  });

  test('someone outside the server holds no immune role', () => {
    expect(
      validateTarget(config({ immuneRoleIds: [LOW_ROLE] }), { ...base, targetRoleIds: null }),
    ).toEqual({ ok: true });
  });
});

describe('mayReview', () => {
  const report = { reporterId: REPORTER, targetId: MEMBER, assigneeId: null };

  function actor(overrides: Partial<ReviewActor> = {}): ReviewActor {
    return { id: MODERATOR, roleIds: [], permissions: 0n, source: 'discord', ...overrides };
  }

  test('Manage Server, Administrator, the owner or a reviewer role may review', () => {
    const reviewers = config({ reviewerRoleIds: [MOD_ROLE] });

    expect(mayReview(reviewers, actor(), report)).toMatchObject({ ok: false });
    expect(mayReview(reviewers, actor({ permissions: Permissions.ManageGuild }), report).ok).toBe(
      true,
    );
    expect(mayReview(reviewers, actor({ permissions: Permissions.Administrator }), report).ok).toBe(
      true,
    );
    expect(mayReview(reviewers, actor({ roleIds: [MOD_ROLE] }), report).ok).toBe(true);
    expect(mayReview(reviewers, actor({ id: OWNER, owner: true }), report).ok).toBe(true);
  });

  test('nobody reviews a report about themselves, whatever they hold', () => {
    const result = mayReview(
      config(),
      actor({ id: MEMBER, permissions: Permissions.Administrator, owner: true }),
      report,
      'view',
    );
    expect(result).toEqual({ ok: false, message: 'You can’t review a report about yourself.' });
  });

  test('the reporter may not accept or dismiss their own report unless they own the server', () => {
    const admin = actor({ id: REPORTER, permissions: Permissions.ManageGuild });

    expect(mayReview(config(), admin, report, 'claim').ok).toBe(true);
    expect(mayReview(config(), admin, report, 'accept').ok).toBe(false);
    expect(mayReview(config(), admin, report, 'dismiss').ok).toBe(false);
    expect(mayReview(config(), { ...admin, owner: true }, report, 'accept').ok).toBe(true);
  });

  test('only the assignee or an admin may unclaim', () => {
    const claimed = { assigneeId: MODERATOR };

    expect(mayUnclaim(claimed, actor()).ok).toBe(true);
    expect(mayUnclaim(claimed, actor({ id: REPORTER }))).toMatchObject({ ok: false });
    expect(
      mayUnclaim(claimed, actor({ id: REPORTER, permissions: Permissions.ManageGuild })).ok,
    ).toBe(true);
  });
});
