import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { mayReview } from '../src/authorize.ts';
import { type AppealPanel, appealsConfigSchema } from '../src/config.ts';

const REVIEWER_ROLE = '410000000000000001';
const OTHER_ROLE = '410000000000000002';

function panel(overrides: Partial<AppealPanel> = {}): AppealPanel {
  return {
    id: 'ban',
    name: 'Ban appeal',
    enabled: true,
    blurb: '',
    questions: [{ key: 'why', label: 'Why?', required: true, maxLength: 1024 }],
    windowDays: 30,
    cooldownDays: 30,
    allowResubmit: false,
    onApprove: 'unban',
    liftBlocklistOnApprove: true,
    approvedMessage: 'Accepted.',
    deniedMessage: 'Turned down.',
    ...overrides,
  };
}

const BARE = appealsConfigSchema.parse({});

describe('who may decide an appeal', () => {
  test('Manage Server always may', () => {
    expect(mayReview(BARE, panel(), Permissions.ManageGuild, [])).toEqual({ ok: true });
  });

  test('nobody else may, when no reviewer role is named', () => {
    const check = mayReview(BARE, panel(), Permissions.BanMembers, [OTHER_ROLE]);

    expect(check.ok).toBe(false);
    expect(!check.ok && check.humanReason).toContain('Manage Server');
  });

  // A named reviewer role is a grant, not a filter: a server naming one is saying those people may
  // review whether or not Discord would otherwise let them.
  test('a named reviewer role may, without Manage Server', () => {
    const config = appealsConfigSchema.parse({ reviewerRoleIds: [REVIEWER_ROLE] });

    expect(mayReview(config, panel(), 0n, [REVIEWER_ROLE])).toEqual({ ok: true });
  });

  test('somebody without that role still may not', () => {
    const config = appealsConfigSchema.parse({ reviewerRoleIds: [REVIEWER_ROLE] });
    const check = mayReview(config, panel(), 0n, [OTHER_ROLE]);

    expect(check.ok).toBe(false);
    expect(!check.ok && check.humanReason).toContain('appeal reviewers');
  });
});
