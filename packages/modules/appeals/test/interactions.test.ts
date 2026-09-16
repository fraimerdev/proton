import { describe, expect, test } from 'bun:test';
import {
  Permissions,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import {
  callsOf,
  harness,
  MEMBER,
  MOD,
  OTHER_MOD,
  OTHER_ROLE,
  panel,
  REVIEWER_ROLE,
  replyColour,
  replyCount,
  replyText,
} from './harness.ts';

describe('deciding an appeal', () => {
  test('accepting it lifts the ban and answers green', async () => {
    const fake = harness();
    const appeal = await fake.file();

    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'decided', decision: 'approved', appealId: appeal.id });
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 accepted. <@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect(callsOf(fake, 'unban')).toHaveLength(1);
  });

  test('turning it down answers green too — the decision was carried out', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, decision: 'denied' });

    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 turned down. <@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect(callsOf(fake, 'unban')).toHaveLength(0);
  });

  test('a named reviewer role may decide without Manage Server', async () => {
    const fake = harness({ config: { reviewerRoleIds: [REVIEWER_ROLE] } });
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, permissions: 0n, roleIds: [REVIEWER_ROLE] });

    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect((await fake.store.find(appeal.guildId, appeal.id))?.status).toBe('approved');
  });
});

describe('when Proton cannot decide it', () => {
  test('somebody without Manage Server is refused in red, and nothing is recorded', async () => {
    const fake = harness();
    const appeal = await fake.file();

    const outcome = await fake.press({
      appealId: appeal.id,
      permissions: Permissions.BanMembers,
      roleIds: [OTHER_ROLE],
    });

    expect(outcome.action).toBe('refused');
    expect(replyText(fake)).toStartWith(STATUS_ERROR_EMOJI);
    expect(replyText(fake)).toContain('Manage Server');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
    expect((await fake.store.find(appeal.guildId, appeal.id))?.status).toBe('open');
    expect(callsOf(fake, 'unban')).toHaveLength(0);
  });

  test('a role-gated server names its reviewers rather than Manage Server', async () => {
    const fake = harness({ config: { reviewerRoleIds: [REVIEWER_ROLE] } });
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id, permissions: 0n, roleIds: [OTHER_ROLE] });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Only this server’s appeal reviewers can decide this one.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an appeal that is gone says so in red', async () => {
    const fake = harness();

    const outcome = await fake.press({ appealId: 'appeal-404' });

    expect(outcome).toEqual({ action: 'ignored', reason: 'no such appeal' });
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} That appeal is no longer here, so nothing has changed.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a removed form is named, because Proton no longer knows what accepting means', async () => {
    const fake = harness({ panels: [panel({ id: 'other' })] });
    const appeal = await fake.file();

    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'refused', reason: 'the panel is gone' });
    expect(replyText(fake)).toStartWith(STATUS_ERROR_EMOJI);
    expect(replyText(fake)).toContain('has been removed');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an unbound store refuses in red and says so in the log', async () => {
    const fake = harness({ store: false });

    const outcome = await fake.press();

    expect(outcome).toEqual({ action: 'refused', reason: 'the appeal store is unbound' });
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} I cannot record appeal decisions right now, so nothing has changed.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
    expect(fake.logs.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('two reviewers at once', () => {
  test('the loser is told who got there first, in red', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id });
    const outcome = await fake.press({
      appealId: appeal.id,
      decision: 'denied',
      userId: OTHER_MOD,
    });

    expect(outcome).toEqual({ action: 'ignored', reason: 'already decided' });
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Somebody else got there first — appeal #1 was accepted by <@${MOD}>.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  // Pressing the same button again repairs a crash between the decision and the unban, so it ends
  // green: the appeal really is accepted and the rest has now been carried out.
  test('pressing the same button again finishes the rest and answers green', async () => {
    const fake = harness();
    const appeal = await fake.file();

    await fake.press({ appealId: appeal.id });
    const outcome = await fake.press({ appealId: appeal.id });

    expect(outcome).toEqual({ action: 'decided', decision: 'approved', appealId: appeal.id });
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Appeal #1 was already accepted. I have finished carrying it out, ` +
        `and <@${MEMBER}> has been told.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
    expect(replyCount(fake)).toBe(2);
    expect(callsOf(fake, 'unban')).toHaveLength(2);
  });
});
